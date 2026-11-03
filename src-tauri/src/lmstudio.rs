//! The Models panel's bridge to LM Studio's `lms` command: list, load, unload and run its local server.
//!
//! Only a fixed set of `lms` subcommands can be run, and every value that reaches the command line is
//! checked first, so the panel can never turn into a general command runner.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && !s.starts_with('-') && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || "._/:@-".contains(c))
}

/// How a load may use the GPU: `max`, `off`, `auto`, or a fraction like `0.5`.
fn safe_gpu(s: &str) -> bool {
    matches!(s, "max" | "off" | "auto") || s.parse::<f32>().is_ok_and(|v| (0.0..=1.0).contains(&v))
}

/// The arguments for one allowed action, or why it is refused.
pub fn build_args(action: &str, model: Option<&str>, gpu: Option<&str>, context: Option<u32>) -> Result<(Vec<String>, u64), String> {
    let s = |x: &str| x.to_string();
    let need_model = || model.filter(|m| safe_name(m)).map(s).ok_or_else(|| "That model name is not valid.".to_string());
    Ok(match action {
        "version" => (vec![s("version")], 15),
        "list" => (vec![s("ls"), s("--json")], 30),
        "loaded" => (vec![s("ps"), s("--json")], 30),
        "server_status" => (vec![s("server"), s("status")], 15),
        "server_start" => (vec![s("server"), s("start")], 60),
        "server_stop" => (vec![s("server"), s("stop")], 30),
        "unload_all" => (vec![s("unload"), s("--all")], 60),
        "unload" => (vec![s("unload"), need_model()?], 60),
        "load" => {
            let mut a = vec![s("load"), need_model()?, s("--yes")];
            if let Some(g) = gpu {
                if !safe_gpu(g) {
                    return Err("GPU offload must be max, off, auto or a number from 0 to 1.".into());
                }
                a.push(format!("--gpu={g}"));
            }
            if let Some(c) = context {
                if !(256..=4_194_304).contains(&c) {
                    return Err("Context length must be between 256 and 4194304.".into());
                }
                a.push(format!("--context-length={c}"));
            }
            (a, 600)
        }
        _ => return Err("That action is not allowed.".into()),
    })
}

/// Run `lms` with the checked arguments and return what it printed.
pub fn run(action: &str, model: Option<&str>, gpu: Option<&str>, context: Option<u32>) -> Result<String, String> {
    let (args, secs) = build_args(action, model, gpu, context)?;
    let exe = crate::agents::resolve_command("lms")
        .ok_or_else(|| "The lms command was not found. Install LM Studio, open it once, then run \"lms bootstrap\" in a terminal.".to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Could not start lms: {e}"))?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut o = String::new();
        let mut e = String::new();
        if let Some(h) = out.as_mut() {
            let _ = h.read_to_string(&mut o);
        }
        if let Some(h) = err.as_mut() {
            let _ = h.read_to_string(&mut e);
        }
        let status = child.wait().ok();
        let _ = tx.send((o, e, status.is_some_and(|s| s.success())));
    });
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok((o, e, ok)) => {
            let text = if o.trim().is_empty() { e } else { o };
            let text: String = text.chars().take(200_000).collect();
            if ok || !text.trim().is_empty() && action.starts_with("server") {
                Ok(text)
            } else {
                Err(text.trim().chars().take(600).collect::<String>())
            }
        }
        Err(_) => Err(format!("lms did not finish within {secs} seconds.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_actions_with_checked_values_are_built() {
        assert_eq!(build_args("list", None, None, None).unwrap().0, ["ls", "--json"]);
        let (a, _) = build_args("load", Some("qwen/qwen3-8b"), Some("0.5"), Some(8192)).unwrap();
        assert_eq!(a, ["load", "qwen/qwen3-8b", "--yes", "--gpu=0.5", "--context-length=8192"]);
        assert!(build_args("load", Some("--evil"), None, None).is_err());
        assert!(build_args("load", Some("a b"), None, None).is_err());
        assert!(build_args("load", Some("m"), Some("1;rm"), None).is_err());
        assert!(build_args("load", Some("m"), None, Some(5)).is_err());
        assert!(build_args("rm", None, None, None).is_err());
        assert!(build_args("unload", None, None, None).is_err());
    }
}
