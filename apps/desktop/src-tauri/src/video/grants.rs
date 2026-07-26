use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::error::VideoCommandError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantCategory {
    Project,
    Source,
    Output,
}

impl GrantCategory {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Source => "source",
            Self::Output => "output",
        }
    }
}

#[derive(Debug, Default)]
struct OwnerGrants {
    projects: HashSet<PathBuf>,
    sources: HashSet<PathBuf>,
    outputs: HashSet<PathBuf>,
}

impl OwnerGrants {
    fn category(&self, category: GrantCategory) -> &HashSet<PathBuf> {
        match category {
            GrantCategory::Project => &self.projects,
            GrantCategory::Source => &self.sources,
            GrantCategory::Output => &self.outputs,
        }
    }

    fn category_mut(&mut self, category: GrantCategory) -> &mut HashSet<PathBuf> {
        match category {
            GrantCategory::Project => &mut self.projects,
            GrantCategory::Source => &mut self.sources,
            GrantCategory::Output => &mut self.outputs,
        }
    }

    fn collides_with_other_category(&self, category: GrantCategory, path: &Path) -> bool {
        [
            GrantCategory::Project,
            GrantCategory::Source,
            GrantCategory::Output,
        ]
        .into_iter()
        .filter(|candidate| *candidate != category)
        .any(|candidate| self.category(candidate).contains(path))
    }
}

#[derive(Debug, Default)]
pub struct VideoPathGrants {
    owners: Mutex<HashMap<String, OwnerGrants>>,
}

impl VideoPathGrants {
    pub fn grant_existing_file(
        &self,
        owner_label: &str,
        category: GrantCategory,
        path: &Path,
    ) -> Result<PathBuf, VideoCommandError> {
        let normalized = normalize_existing_file(path, "grant_existing", category)?;
        self.insert(owner_label, category, normalized.clone())?;
        Ok(normalized)
    }

    pub fn grant_destination(
        &self,
        owner_label: &str,
        category: GrantCategory,
        path: &Path,
    ) -> Result<PathBuf, VideoCommandError> {
        if category == GrantCategory::Source {
            return Err(VideoCommandError::invalid_path(
                "grant_destination",
                category.as_str(),
            ));
        }
        let normalized = normalize_destination(path, "grant_destination", category)?;
        self.insert(owner_label, category, normalized.clone())?;
        Ok(normalized)
    }

    pub fn authorize(
        &self,
        owner_label: &str,
        category: GrantCategory,
        path: &Path,
    ) -> Result<PathBuf, VideoCommandError> {
        let normalized = normalize_for_authorization(path, category)?;
        let owners = self
            .owners
            .lock()
            .map_err(|_| VideoCommandError::project_io("authorize_path", category.as_str()))?;
        if owners
            .get(owner_label)
            .is_some_and(|grants| grants.category(category).contains(&normalized))
        {
            Ok(normalized)
        } else {
            Err(VideoCommandError::path_not_granted(
                "authorize_path",
                category.as_str(),
            ))
        }
    }

    pub fn is_granted_normalized(
        &self,
        owner_label: &str,
        category: GrantCategory,
        normalized_path: &Path,
    ) -> Result<bool, VideoCommandError> {
        let owners = self
            .owners
            .lock()
            .map_err(|_| VideoCommandError::project_io("check_path_grant", category.as_str()))?;
        Ok(owners
            .get(owner_label)
            .is_some_and(|grants| grants.category(category).contains(normalized_path)))
    }

    pub fn revoke_window(&self, owner_label: &str) -> Result<(), VideoCommandError> {
        self.owners
            .lock()
            .map_err(|_| VideoCommandError::project_io("revoke_window", "all"))?
            .remove(owner_label);
        Ok(())
    }

    pub(crate) fn grant_opened_project(
        &self,
        owner_label: &str,
        project_path: PathBuf,
        relative_source_path: Option<PathBuf>,
    ) -> Result<(), VideoCommandError> {
        self.grant_opened_project_sources(
            owner_label,
            project_path,
            relative_source_path.into_iter().collect(),
        )
    }

    pub(crate) fn grant_opened_project_sources(
        &self,
        owner_label: &str,
        project_path: PathBuf,
        relative_source_paths: Vec<PathBuf>,
    ) -> Result<(), VideoCommandError> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| VideoCommandError::project_io("grant_open_project", "project"))?;
        let grants = owners.entry(owner_label.to_owned()).or_default();
        if grants.collides_with_other_category(GrantCategory::Project, &project_path) {
            return Err(VideoCommandError::invalid_path(
                "grant_open_project",
                "category_collision",
            ));
        }
        for source_path in &relative_source_paths {
            if source_path == &project_path
                || grants.collides_with_other_category(GrantCategory::Source, source_path)
            {
                return Err(VideoCommandError::invalid_path(
                    "grant_open_project",
                    "category_collision",
                ));
            }
        }
        grants.projects.insert(project_path);
        grants.sources.extend(relative_source_paths);
        Ok(())
    }

    fn insert(
        &self,
        owner_label: &str,
        category: GrantCategory,
        normalized_path: PathBuf,
    ) -> Result<(), VideoCommandError> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| VideoCommandError::project_io("grant_path", category.as_str()))?;
        let grants = owners.entry(owner_label.to_owned()).or_default();
        if grants.collides_with_other_category(category, &normalized_path) {
            return Err(VideoCommandError::invalid_path(
                "grant_path",
                "category_collision",
            ));
        }
        grants.category_mut(category).insert(normalized_path);
        Ok(())
    }
}

pub(crate) fn normalize_existing_file(
    path: &Path,
    operation: &'static str,
    category: GrantCategory,
) -> Result<PathBuf, VideoCommandError> {
    let metadata = fs::metadata(path)
        .map_err(|_| VideoCommandError::invalid_path(operation, category.as_str()))?;
    if !metadata.is_file() {
        return Err(VideoCommandError::invalid_path(
            operation,
            category.as_str(),
        ));
    }
    fs::canonicalize(path)
        .map_err(|_| VideoCommandError::invalid_path(operation, category.as_str()))
}

pub(crate) fn normalize_destination(
    path: &Path,
    operation: &'static str,
    category: GrantCategory,
) -> Result<PathBuf, VideoCommandError> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| VideoCommandError::invalid_path(operation, category.as_str()))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| VideoCommandError::invalid_path(operation, category.as_str()))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| VideoCommandError::invalid_path(operation, category.as_str()))?;
    let parent_metadata = fs::metadata(&canonical_parent)
        .map_err(|_| VideoCommandError::invalid_path(operation, category.as_str()))?;
    if !parent_metadata.is_dir() {
        return Err(VideoCommandError::invalid_path(
            operation,
            category.as_str(),
        ));
    }
    Ok(canonical_parent.join(file_name))
}

fn normalize_for_authorization(
    path: &Path,
    category: GrantCategory,
) -> Result<PathBuf, VideoCommandError> {
    if path.exists() {
        normalize_existing_file(path, "authorize_path", category)
    } else if category == GrantCategory::Source {
        Err(VideoCommandError::invalid_path(
            "authorize_path",
            category.as_str(),
        ))
    } else {
        normalize_destination(path, "authorize_path", category)
    }
}
