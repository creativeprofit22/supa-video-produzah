use std::{
    collections::VecDeque,
    ffi::OsString,
    io,
    process::{ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use process_wrap::tokio::{ChildWrapper, CommandWrap, KillOnDrop};
#[cfg(windows)]
use process_wrap::tokio::{CreationFlags, JobObject};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    task::JoinHandle,
    time::{self, Instant},
};
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

pub(crate) const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) type StdoutRecordObserver = Arc<dyn Fn(&[u8]) + Send + Sync + 'static>;

#[derive(Debug, Clone)]
pub(crate) struct ProcessSpec {
    pub(crate) program: OsString,
    pub(crate) args: Vec<OsString>,
    pub(crate) operation: &'static str,
    pub(crate) timeout: Duration,
    pub(crate) stdout_limit: usize,
    pub(crate) stderr_tail_limit: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProcessCancellation {
    cancelled: Arc<AtomicBool>,
}

impl ProcessCancellation {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn wait(&self) {
        while !self.is_cancelled() {
            time::sleep(CANCELLATION_POLL_INTERVAL).await;
        }
    }
}

#[derive(Debug)]
pub(crate) struct SupervisedOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr_tail: Vec<u8>,
    pub(crate) stderr_truncated: bool,
}

#[derive(Debug)]
pub(crate) enum ProcessFailure {
    Spawn {
        operation: &'static str,
        kind: io::ErrorKind,
    },
    Timeout {
        operation: &'static str,
    },
    Cancelled {
        operation: &'static str,
    },
    StdoutLimit {
        operation: &'static str,
        limit: usize,
    },
    Io {
        operation: &'static str,
    },
    NonZero {
        operation: &'static str,
        exit_code: Option<i32>,
        stderr_tail: Vec<u8>,
        stderr_truncated: bool,
    },
}

impl ProcessFailure {
    pub(crate) fn operation(&self) -> &'static str {
        match self {
            Self::Spawn { operation, .. }
            | Self::Timeout { operation }
            | Self::Cancelled { operation }
            | Self::StdoutLimit { operation, .. }
            | Self::Io { operation }
            | Self::NonZero { operation, .. } => operation,
        }
    }
}

#[derive(Debug)]
enum StdoutReadFailure {
    Limit,
    Io,
}

#[derive(Debug)]
struct StderrCapture {
    tail: Vec<u8>,
    truncated: bool,
}

pub(crate) async fn run_supervised(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
) -> Result<SupervisedOutput, ProcessFailure> {
    let command = child_command(&spec);
    run_supervised_command(spec, cancellation, command, None).await
}

pub(crate) async fn run_supervised_streaming(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    observer: StdoutRecordObserver,
) -> Result<SupervisedOutput, ProcessFailure> {
    let command = child_command(&spec);
    run_supervised_command(spec, cancellation, command, Some(observer)).await
}

#[cfg(test)]
pub(crate) async fn run_supervised_with_test_environment(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    environment: Vec<(OsString, Option<OsString>)>,
) -> Result<SupervisedOutput, ProcessFailure> {
    run_supervised_with_test_environment_and_observer(spec, cancellation, environment, None).await
}

#[cfg(test)]
pub(crate) async fn run_supervised_streaming_with_test_environment(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    environment: Vec<(OsString, Option<OsString>)>,
    observer: StdoutRecordObserver,
) -> Result<SupervisedOutput, ProcessFailure> {
    run_supervised_with_test_environment_and_observer(
        spec,
        cancellation,
        environment,
        Some(observer),
    )
    .await
}

#[cfg(test)]
async fn run_supervised_with_test_environment_and_observer(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    environment: Vec<(OsString, Option<OsString>)>,
    observer: Option<StdoutRecordObserver>,
) -> Result<SupervisedOutput, ProcessFailure> {
    let mut command = child_command(&spec);
    for (name, value) in environment {
        if let Some(value) = value {
            command.env(name, value);
        } else {
            command.env_remove(name);
        }
    }
    run_supervised_command(spec, cancellation, command, observer).await
}

fn child_command(spec: &ProcessSpec) -> Command {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

async fn run_supervised_command(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    command: Command,
    stdout_observer: Option<StdoutRecordObserver>,
) -> Result<SupervisedOutput, ProcessFailure> {
    let mut wrapped = CommandWrap::from(command);
    wrapped.wrap(KillOnDrop);
    #[cfg(unix)]
    wrapped.wrap(ProcessGroup::leader());
    #[cfg(windows)]
    wrapped.wrap(CreationFlags(CREATE_NO_WINDOW));
    #[cfg(windows)]
    wrapped.wrap(JobObject);

    let mut child = wrapped.spawn().map_err(|error| ProcessFailure::Spawn {
        operation: spec.operation,
        kind: error.kind(),
    })?;
    let Some(stdout) = child.stdout().take() else {
        kill_and_wait(child.as_mut()).await;
        return Err(ProcessFailure::Io {
            operation: spec.operation,
        });
    };
    let Some(stderr) = child.stderr().take() else {
        drop(stdout);
        kill_and_wait(child.as_mut()).await;
        return Err(ProcessFailure::Io {
            operation: spec.operation,
        });
    };

    let stdout_limit = spec.stdout_limit;
    let mut stdout_task = tokio::spawn(async move {
        match stdout_observer {
            Some(observer) => read_stdout_records(stdout, stdout_limit, observer).await,
            None => read_stdout_bounded(stdout, stdout_limit).await,
        }
    });
    let mut stderr_task = tokio::spawn(read_stderr_tail(stderr, spec.stderr_tail_limit));
    let mut stdout_result = None;
    let mut stderr_result = None;
    let mut status = None;
    let deadline = time::sleep_until(Instant::now() + spec.timeout);
    tokio::pin!(deadline);
    let cancellation_wait = cancellation.wait();
    tokio::pin!(cancellation_wait);

    while stdout_result.is_none() || stderr_result.is_none() || status.is_none() {
        tokio::select! {
            joined = &mut stdout_task, if stdout_result.is_none() => {
                match joined {
                    Ok(Ok(stdout)) => stdout_result = Some(stdout),
                    Ok(Err(StdoutReadFailure::Limit)) => {
                        settle_after_failure(
                            child.as_mut(),
                            &mut stdout_task,
                            true,
                            &mut stderr_task,
                            stderr_result.is_some(),
                        ).await;
                        return Err(ProcessFailure::StdoutLimit {
                            operation: spec.operation,
                            limit: spec.stdout_limit,
                        });
                    }
                    Ok(Err(StdoutReadFailure::Io)) | Err(_) => {
                        settle_after_failure(
                            child.as_mut(),
                            &mut stdout_task,
                            true,
                            &mut stderr_task,
                            stderr_result.is_some(),
                        ).await;
                        return Err(ProcessFailure::Io {
                            operation: spec.operation,
                        });
                    }
                }
            }
            joined = &mut stderr_task, if stderr_result.is_none() => {
                match joined {
                    Ok(Ok(stderr)) => stderr_result = Some(stderr),
                    Ok(Err(_)) | Err(_) => {
                        settle_after_failure(
                            child.as_mut(),
                            &mut stdout_task,
                            stdout_result.is_some(),
                            &mut stderr_task,
                            true,
                        ).await;
                        return Err(ProcessFailure::Io {
                            operation: spec.operation,
                        });
                    }
                }
            }
            waited = child.wait(), if status.is_none() => {
                match waited {
                    Ok(exit_status) => status = Some(exit_status),
                    Err(_) => {
                        settle_after_failure(
                            child.as_mut(),
                            &mut stdout_task,
                            stdout_result.is_some(),
                            &mut stderr_task,
                            stderr_result.is_some(),
                        ).await;
                        return Err(ProcessFailure::Io {
                            operation: spec.operation,
                        });
                    }
                }
            }
            () = &mut cancellation_wait => {
                settle_after_failure(
                    child.as_mut(),
                    &mut stdout_task,
                    stdout_result.is_some(),
                    &mut stderr_task,
                    stderr_result.is_some(),
                ).await;
                return Err(ProcessFailure::Cancelled {
                    operation: spec.operation,
                });
            }
            () = &mut deadline => {
                settle_after_failure(
                    child.as_mut(),
                    &mut stdout_task,
                    stdout_result.is_some(),
                    &mut stderr_task,
                    stderr_result.is_some(),
                ).await;
                return Err(ProcessFailure::Timeout {
                    operation: spec.operation,
                });
            }
        }
    }

    let status = status.expect("loop requires a process status");
    let stdout = stdout_result.expect("loop requires stdout");
    let stderr = stderr_result.expect("loop requires stderr");
    if !status.success() {
        return Err(ProcessFailure::NonZero {
            operation: spec.operation,
            exit_code: status.code(),
            stderr_tail: stderr.tail,
            stderr_truncated: stderr.truncated,
        });
    }

    Ok(SupervisedOutput {
        status,
        stdout,
        stderr_tail: stderr.tail,
        stderr_truncated: stderr.truncated,
    })
}

async fn kill_and_wait(child: &mut dyn ChildWrapper) {
    if Box::into_pin(child.kill()).await.is_err() {
        let _ = child.wait().await;
    }
}

async fn settle_after_failure(
    child: &mut dyn ChildWrapper,
    stdout_task: &mut JoinHandle<Result<Vec<u8>, StdoutReadFailure>>,
    stdout_done: bool,
    stderr_task: &mut JoinHandle<io::Result<StderrCapture>>,
    stderr_done: bool,
) {
    kill_and_wait(child).await;
    if !stdout_done {
        let _ = stdout_task.await;
    }
    if !stderr_done {
        let _ = stderr_task.await;
    }
}

async fn read_stdout_bounded(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> Result<Vec<u8>, StdoutReadFailure> {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|_| StdoutReadFailure::Io)?;
        if read == 0 {
            return Ok(output);
        }
        if output
            .len()
            .checked_add(read)
            .is_none_or(|size| size > limit)
        {
            return Err(StdoutReadFailure::Limit);
        }
        output.extend_from_slice(&buffer[..read]);
    }
}

async fn read_stdout_records(
    mut reader: impl AsyncRead + Unpin,
    line_limit: usize,
    observer: StdoutRecordObserver,
) -> Result<Vec<u8>, StdoutReadFailure> {
    let mut pending = Vec::with_capacity(line_limit.min(8 * 1024));
    let mut record = Vec::with_capacity(line_limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|_| StdoutReadFailure::Io)?;
        if read == 0 {
            if !pending.is_empty() {
                append_progress_line(&mut record, &pending, line_limit)?;
            }
            if !record.is_empty() {
                observer(&record);
            }
            return Ok(Vec::new());
        }
        for byte in &buffer[..read] {
            if *byte == b'\n' {
                if pending.last() == Some(&b'\r') {
                    pending.pop();
                }
                append_progress_line(&mut record, &pending, line_limit)?;
                let record_complete = pending.starts_with(b"progress=");
                pending.clear();
                if record_complete {
                    observer(&record);
                    record.clear();
                }
            } else {
                if pending.len() >= line_limit {
                    return Err(StdoutReadFailure::Limit);
                }
                pending.push(*byte);
            }
        }
    }
}

fn append_progress_line(
    record: &mut Vec<u8>,
    line: &[u8],
    line_limit: usize,
) -> Result<(), StdoutReadFailure> {
    let added = line.len().saturating_add(1);
    if record
        .len()
        .checked_add(added)
        .is_none_or(|size| size > line_limit)
    {
        return Err(StdoutReadFailure::Limit);
    }
    record.extend_from_slice(line);
    record.push(b'\n');
    Ok(())
}

async fn read_stderr_tail(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> io::Result<StderrCapture> {
    let mut tail = VecDeque::with_capacity(limit.min(64 * 1024));
    let mut truncated = false;
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            return Ok(StderrCapture {
                tail: tail.into_iter().collect(),
                truncated,
            });
        }
        for byte in &buffer[..read] {
            if tail.len() == limit {
                truncated = true;
                if limit == 0 {
                    continue;
                }
                tail.pop_front();
            }
            tail.push_back(*byte);
        }
    }
}
