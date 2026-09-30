//! Use-policy matrix: license code x intended use -> allow / warn / block.
//! Mirrored by `packages/video-rights/src/policy.ts`.

use super::types::{
    LicenseCode, PolicyDecision, PolicyOutcome, PolicyReasonCode, UsePolicyProfile,
};

fn reasons_for(code: LicenseCode) -> Vec<PolicyReasonCode> {
    let text = code.as_str();
    let mut reasons = Vec::new();
    if text.starts_with("by") {
        reasons.push(PolicyReasonCode::AttributionRequired);
    }
    if text.ends_with("-sa") {
        reasons.push(PolicyReasonCode::ShareAlikeObligation);
    }
    if text.contains("-nc") {
        reasons.push(PolicyReasonCode::NoncommercialOnly);
    }
    if text.ends_with("-nd") {
        reasons.push(PolicyReasonCode::NoDerivatives);
    }
    if code == LicenseCode::Custom {
        reasons.push(PolicyReasonCode::CustomTermsReview);
    }
    if code == LicenseCode::Unknown {
        reasons.push(PolicyReasonCode::LicenseUnknown);
    }
    reasons
}

fn base_outcome(code: LicenseCode, profile: UsePolicyProfile) -> PolicyOutcome {
    use PolicyOutcome::{Allow, Block, Warn};
    let is_private = profile == UsePolicyProfile::PrivatePreview;
    let is_commercial = !matches!(
        profile,
        UsePolicyProfile::PrivatePreview | UsePolicyProfile::NoncommercialPublic
    );
    let is_high_stakes = matches!(
        profile,
        UsePolicyProfile::CommercialClient | UsePolicyProfile::Broadcast
    );
    match code {
        LicenseCode::Cc0 | LicenseCode::Pdm | LicenseCode::By => Allow,
        LicenseCode::BySa if is_private => Allow,
        LicenseCode::BySa if is_high_stakes => Block,
        LicenseCode::BySa => Warn,
        LicenseCode::ByNc if is_commercial => Block,
        LicenseCode::ByNc => Allow,
        LicenseCode::ByNcSa if is_private => Allow,
        LicenseCode::ByNcSa if is_commercial => Block,
        LicenseCode::ByNcSa => Warn,
        LicenseCode::ByNd | LicenseCode::ByNcNd if is_private => Allow,
        LicenseCode::ByNd | LicenseCode::ByNcNd => Block,
        LicenseCode::Custom if is_private => Allow,
        LicenseCode::Custom => Warn,
        LicenseCode::Unknown if is_private => Warn,
        LicenseCode::Unknown => Block,
    }
}

pub fn evaluate_policy(
    code: LicenseCode,
    profile: UsePolicyProfile,
    conflict: bool,
) -> PolicyDecision {
    let mut outcome = base_outcome(code, profile);
    let mut reasons = reasons_for(code);
    if conflict {
        reasons.push(PolicyReasonCode::LicenseConflict);
        if outcome == PolicyOutcome::Allow {
            outcome = PolicyOutcome::Warn;
        }
    }
    reasons.sort();
    PolicyDecision { outcome, reasons }
}
