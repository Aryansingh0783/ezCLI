//! Agent definitions and PATH resolution.
//!
//! An agent is a CLI the app can launch (claude, codex, …) with a set of
//! model and mode variants whose args are appended to the launch line.
//! Arguments only ever come from this file, never the frontend, so a
//! compromised page cannot talk the backend into running an arbitrary
//! command line.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Variant {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, rename = "resumesSession")]
    pub resumes_session: bool,
    /// Needs the user's own paid API key. Hidden unless they opt in.
    #[serde(default)]
    pub paid: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct AgentDef {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub icon: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub modes: Vec<Variant>,
    #[serde(default)]
    pub models: Vec<Variant>,
    /// How the CLI accepts user-selected images. This is capability metadata
    /// only; the frontend must still implement the corresponding transfer.
    #[serde(default, rename = "imageTransport")]
    pub image_transport: Option<String>,
    /// Per-session reasoning effort choices supported by this CLI. Empty means
    /// the agent does not expose a portable effort control.
    #[serde(default)]
    pub efforts: Vec<Variant>,
    /// How this CLI attaches ezCLI's PC-control MCP server: "claude", "codex"
    /// or "none". Omitted = inferred from the command name, so configs written
    /// before this field existed keep working.
    #[serde(default)]
    pub mcp: Option<String>,
    /// "free" marks agents usable without any paid plan; the wizard routes
    /// users without a paid backend to these.
    #[serde(default)]
    pub tier: Option<String>,
    /// Ask the agent itself which models are usable instead of hardcoding a
    /// list that goes stale. See `parse_catalog`.
    #[serde(default, rename = "modelsFrom")]
    pub models_from: Option<ModelsFrom>,
    /// Shell command shown to users who don't have this agent yet. Display
    /// only; ezCLI never runs it.
    #[serde(default)]
    pub install: Option<String>,
    /// Free/paid labels for this agent's models, shown in the Model menu.
    #[serde(default, rename = "modelPricing")]
    pub model_pricing: Option<ModelPricing>,
    /// How to run one non-interactive turn, for group chats.
    #[serde(default)]
    pub headless: Option<Headless>,
    /// How the composer hands a message to this CLI's own input box.
    #[serde(default)]
    pub submit: Option<Submit>,
}

/// Timing for sending a composer message into a CLI's terminal UI. TUIs treat
/// fast typed characters as a paste and swallow the Enter that follows, so the
/// default is a real bracketed paste, a pause, then Enter.
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Submit {
    /// "auto" (default): paste when the CLI enabled bracketed paste, else type.
    /// "always" / "never" force one or the other.
    #[serde(default)]
    pub paste: Option<String>,
    /// Milliseconds to wait after the text before pressing Enter.
    #[serde(default, rename = "delayMs")]
    pub delay_ms: Option<u32>,
}

/// A one-shot, non-interactive run of an agent: the conversation goes in,
/// one reply comes out, the process exits. Used only by group chats.
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Headless {
    /// Placed after the agent's base args, e.g. `["-p"]` or `["exec"]`.
    #[serde(default)]
    pub args: Vec<String>,
    /// Added when the turn may change files.
    #[serde(default)]
    pub edit: Vec<String>,
    /// Added when the turn must not change files.
    #[serde(default, rename = "readOnly")]
    pub read_only: Vec<String>,
    /// "stdin" (default): the prompt is piped in. "file": the prompt is
    /// written to a file passed with `fileFlag`, for CLIs whose prompt must
    /// otherwise go on a command line (too long and too fragile on Windows).
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default, rename = "fileFlag")]
    pub file_flag: Option<String>,
}

impl Headless {
    pub fn uses_file(&self) -> bool {
        self.input.as_deref() == Some("file") && self.file_flag.is_some()
    }
}

/// Arguments for one headless turn: base args, headless args, the model,
/// edit or read-only args, then the prompt file when the CLI takes one.
/// Returns None for an agent without a headless recipe.
pub fn headless_argv(
    a: &AgentDef,
    model_id: &str,
    allow_edits: bool,
    catalog: Option<&[String]>,
    prompt_file: Option<&str>,
) -> Option<Vec<String>> {
    let h = a.headless.as_ref()?;
    let mut out = a.args.clone();
    out.extend(h.args.iter().cloned());
    if let Some(m) = a.models.iter().find(|v| v.id == model_id) {
        out.extend(m.args.clone());
    } else if let (Some(from), Some(cat)) = (&a.models_from, catalog) {
        if cat.iter().any(|c| c == model_id) {
            if let Some(launch) = from.launch_args() {
                out.extend(launch.iter().cloned());
                out.push(model_id.to_string());
            }
        }
    }
    out.extend(if allow_edits { h.edit.clone() } else { h.read_only.clone() });
    if h.uses_file() {
        out.push(h.file_flag.clone().unwrap_or_default());
        out.push(prompt_file?.to_string());
    }
    Some(out)
}

/// Display-only price labels. `default` applies to every model not listed in
/// `free`; both are "free" or "paid". Model ids match without a `-cloud` /
/// `:cloud` suffix, so a catalog name and its CLI alias get the same label.
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct ModelPricing {
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub free: Vec<String>,
    /// One line of context shown under the model list.
    #[serde(default)]
    pub note: Option<String>,
}

/// Run `<command> <args>` to list models, then launch a chosen one with an
/// explicitly declared token sequence plus the validated model id.
#[derive(Deserialize, Clone, Debug)]
pub struct ModelsFrom {
    pub args: Vec<String>,
    /// Legacy one-token model prefix, e.g. `-m`. Kept optional so older
    /// editable configs continue to work while launch supports subcommands.
    #[serde(default)]
    pub flag: Option<String>,
    /// Literal tokens placed before a selected dynamic model, e.g. `["run"]`
    /// for `ollama run <model>`. Preferred over `flag` when present.
    #[serde(default)]
    pub launch: Vec<String>,
    /// Parser contract for this catalog. Omitted keeps the established
    /// provider/model parser; `ollama` accepts only verified `ollama list`
    /// table rows and their bare model names.
    #[serde(default)]
    pub catalog: Option<String>,
    /// Some dynamic catalogs have no safe static default. In that case a
    /// session must not launch until the user has selected a model returned by
    /// the live catalog (for example, `ollama run <model>`).
    #[serde(default, rename = "requireSelection")]
    pub require_selection: bool,
}

impl ModelsFrom {
    fn launch_args(&self) -> Option<&[String]> {
        if !self.launch.is_empty() {
            Some(&self.launch)
        } else {
            self.flag.as_ref().map(std::slice::from_ref)
        }
    }

    pub fn is_ollama_cloud(&self) -> bool {
        self.catalog.as_deref() == Some("ollama-cloud")
    }
}

/// The agents.json shipped with the app. New built-in agents are merged into a
/// user's existing config so people who installed earlier still get them.
pub const BUILTIN: &str = include_str!("../../agents.json");

/// The two attach mechanisms verified against the installed CLIs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpStyle {
    /// `claude --mcp-config <file.json>`
    Claude,
    /// `codex -c mcp_servers.<name>.url=<url>`
    Codex,
}

impl AgentDef {
    pub fn mcp_style(&self) -> Option<McpStyle> {
        // Both built-in Claude entries launch the same executable, but only
        // the coding-agent preset is allowed to receive PC-control tools.
        // Keep this guard in Rust so an older ~/.ezcli/agents.json cannot
        // accidentally turn the chat preset into a privileged backend.
        if self.id == "claude-chat" {
            return None;
        }
        let named = match self.mcp.as_deref().map(str::to_ascii_lowercase).as_deref() {
            Some("claude") => return Some(McpStyle::Claude),
            Some("codex") => return Some(McpStyle::Codex),
            Some(_) => return None, // "none" or anything unrecognised
            None => Path::new(&self.command)
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_ascii_lowercase),
        };
        match named.as_deref() {
            Some("claude") => Some(McpStyle::Claude),
            Some("codex") => Some(McpStyle::Codex),
            _ => None,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct AgentOut {
    pub id: String,
    pub label: String,
    pub vendor: String,
    pub icon: String,
    pub command: String,
    pub args: Vec<String>,
    pub modes: Vec<Variant>,
    pub models: Vec<Variant>,
    pub efforts: Vec<Variant>,
    #[serde(rename = "imageTransport")]
    pub image_transport: String,
    pub available: bool,
    pub resolved: Option<String>,
    /// Whether ezCLI knows how to attach PC control to this CLI.
    pub pc_control: bool,
    /// Usable without any paid plan.
    pub free: bool,
    /// The Model pill can be filled from the agent's own catalog.
    pub dynamic_models: bool,
    /// This catalog is safe to fetch before the CLI is installed because it
    /// comes from a fixed public endpoint, not from a user-supplied command.
    #[serde(rename = "catalogAvailableWithoutCommand")]
    pub catalog_available_without_command: bool,
    /// A dynamic catalog can deliberately omit a runnable default. The UI
    /// uses this to ask for a live model pick before it creates a PTY.
    #[serde(rename = "requiresModelSelection")]
    pub requires_model_selection: bool,
    pub install: Option<String>,
    #[serde(rename = "modelPricing")]
    pub model_pricing: Option<ModelPricing>,
    /// Can take part in group chats (has a headless recipe).
    #[serde(rename = "groupChat")]
    pub group_chat: bool,
    /// Its headless turns can be allowed to change files.
    #[serde(rename = "groupCanEdit")]
    pub group_can_edit: bool,
    pub submit: Option<Submit>,
}

#[derive(Deserialize)]
struct AgentsFile {
    agents: Vec<AgentDef>,
}

pub fn load_agents(path: &Path) -> Result<Vec<AgentDef>> {
    let txt = std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let mut file: AgentsFile = serde_json::from_str(&txt).context("parse agents.json")?;
    merge_builtin(&mut file.agents);

    let mut seen = std::collections::HashSet::new();
    let mut agents = Vec::with_capacity(file.agents.len());
    for mut a in file.agents {
        if a.id.trim().is_empty() {
            anyhow::bail!("agent entry has empty id");
        }
        if !seen.insert(a.id.clone()) {
            anyhow::bail!("duplicate agent id: {}", a.id);
        }
        if a.command.trim().is_empty() {
            anyhow::bail!("agent {} has empty command", a.id);
        }
        if a.label.is_empty() {
            a.label = a.id.clone();
        }
        if a.icon.is_empty() {
            a.icon = "term".into();
        }
        if a.modes.is_empty() {
            a.modes.push(default_variant());
        }
        if a.models.is_empty() {
            a.models.push(default_variant());
        }
        agents.push(a);
    }
    Ok(agents)
}

/// Append built-in agents whose id the user's file doesn't have. The user's
/// own entries always win, including deliberately edited built-ins; removing a
/// built-in is done with an entry whose command is set to something absent.
pub(crate) fn merge_builtin(user: &mut Vec<AgentDef>) {
    let Ok(builtin) = serde_json::from_str::<AgentsFile>(BUILTIN) else {
        return;
    };
    for builtin_agent in builtin.agents {
        if let Some(existing) = user.iter_mut().find(|u| u.id == builtin_agent.id) {
            // Existing configurations are authoritative, but a missing effort
            // list is a safe additive capability for an unchanged built-in
            // command. That lets old first-run configs receive this UI feature
            // without overwriting a custom command or its launch flags.
            if existing.efforts.is_empty()
                && !builtin_agent.efforts.is_empty()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.efforts = builtin_agent.efforts.clone();
            }
            // `imageTransport` was introduced after the first-run config.
            // Add it only to an unchanged built-in command; custom adapters
            // keep their explicit (or intentionally absent) capability.
            let image_missing = existing
                .image_transport
                .as_deref()
                .map(str::trim)
                .map_or(true, str::is_empty);
            if image_missing
                && builtin_agent.image_transport.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.image_transport = builtin_agent.image_transport.clone();
            }
            // Gemini CLI's personal Google sign-in now redirects users to
            // Antigravity. Old stock configs still say `tier: free`; clear
            // only that stale routing hint while preserving any user-supplied
            // modes, models, arguments, and configured API/Vertex setup.
            if existing.id == "gemini"
                && existing.command.eq_ignore_ascii_case("gemini")
                && existing
                    .tier
                    .as_deref()
                    .is_some_and(|tier| tier.eq_ignore_ascii_case("free"))
            {
                existing.tier = None;
            }
            // This explicit value makes the built-in boundary visible in the
            // runtime config too; mcp_style() enforces it independently.
            if existing.id == "claude-chat" {
                existing.mcp = Some("none".into());
            }
            // Install hints are display-only text, added to older stock
            // configs so the "not installed" state can say what to run.
            if existing.install.is_none()
                && builtin_agent.install.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.install = builtin_agent.install.clone();
            }
            // Codex's first-run config hardcoded gpt-5-codex / gpt-5, which
            // newer Codex releases no longer list. An unedited stock entry
            // switches to Codex's live catalog; any other model list stays.
            if existing.id == "codex"
                && existing.models_from.is_none()
                && builtin_agent.models_from.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
                && existing
                    .models
                    .iter()
                    .all(|m| ["default", "gpt-5-codex", "gpt-5"].contains(&m.id.as_str()))
            {
                existing.models = builtin_agent.models.clone();
                existing.models_from = builtin_agent.models_from.clone();
            }
            // Group-chat recipes are additive; an unchanged stock command gets one.
            if existing.headless.is_none()
                && builtin_agent.headless.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.headless = builtin_agent.headless.clone();
            }
            if existing.submit.is_none()
                && builtin_agent.submit.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.submit = builtin_agent.submit.clone();
            }
            // OpenCode's first-run config listed only "default" and read the
            // unfiltered `opencode models`, which on a machine with a Google
            // key returned dozens of paid models and on others fewer. An
            // unedited stock entry takes the shipped fixed free list and the
            // free-only catalog, so every machine shows the same models.
            if existing.id == "opencode"
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
                && existing.models.iter().all(|m| m.id == "default")
                && existing
                    .models_from
                    .as_ref()
                    .map_or(true, |f| f.catalog.is_none() && f.args.first().map(String::as_str) == Some("models"))
            {
                existing.models = builtin_agent.models.clone();
                existing.models_from = builtin_agent.models_from.clone();
            }
            // Which models are free is decided by the shipped list, not by a
            // copy in an old config: a stale list could keep offering a model
            // that now needs payment. Only an unchanged stock command takes it.
            if builtin_agent.model_pricing.is_some()
                && existing.command.eq_ignore_ascii_case(&builtin_agent.command)
            {
                existing.model_pricing = builtin_agent.model_pricing.clone();
            }
        } else {
            user.push(builtin_agent);
        }
    }
}

/// Parse a model catalog printed one `provider/model` per line. Anything else
/// (banners, blank lines, log noise) is ignored, so a catalog command can never
/// smuggle arbitrary text into a launch argument.
pub fn parse_catalog(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| {
            let mut parts = l.splitn(2, '/');
            let (Some(p), Some(m)) = (parts.next(), parts.next()) else { return false };
            let ok = |s: &str, extra: &str| {
                !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c) || extra.contains(c))
            };
            // Must start alphanumeric: an id like `--x/y` would be read as an
            // option by the agent's own argument parser.
            let starts_ok = l.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
            l.len() <= 200 && starts_ok && ok(p, "") && ok(m, ":/@")
        })
        .map(str::to_string)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(1000);
    out
}

/// Parse a catalog using the explicitly declared format for its agent. Most
/// agents use provider/model ids; Ollama prints a table with bare model names.
/// Keeping the latter separate means an arbitrary table or diagnostic cannot
/// become a `run` argument merely because it contains whitespace-separated
/// text.
pub fn parse_catalog_for(from: &ModelsFrom, stdout: &str) -> Vec<String> {
    match from.catalog.as_deref() {
        Some("ollama") => parse_ollama_catalog(stdout),
        Some("codex") => parse_codex_catalog(stdout),
        Some("opencode-free") => parse_opencode_free(stdout),
        _ => parse_catalog(stdout),
    }
}

const MAX_OLLAMA_CLOUD_CATALOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_OLLAMA_CLOUD_MODELS: usize = 200;

#[derive(Deserialize)]
struct OllamaCloudTags {
    models: Vec<OllamaCloudTag>,
}

#[derive(Deserialize)]
struct OllamaCloudTag {
    name: String,
    #[serde(default)]
    size: u64,
}

/// Parse Ollama's public hosted-model catalog into the exact model aliases
/// accepted by a signed-in local Ollama CLI. The hosted API calls a model such
/// as `gemma4:31b`; the CLI's cloud alias is `gemma4:31b-cloud`. Untagged
/// hosted names use the documented `:cloud` tag instead.
///
/// No arbitrary network text reaches argv: the response is bounded, each name
/// is allowlisted, the derived name is validated again, and the result is
/// capped before it is stored in the session catalog.
pub fn parse_ollama_cloud_catalog(stdout: &str) -> Result<Vec<String>, String> {
    if stdout.len() > MAX_OLLAMA_CLOUD_CATALOG_BYTES {
        return Err("Ollama's cloud catalog response was too large.".into());
    }
    let tags: OllamaCloudTags = serde_json::from_str(stdout)
        .map_err(|_| "Ollama's cloud catalog returned an invalid response.".to_string())?;
    let mut unique = std::collections::BTreeMap::<String, u64>::new();
    for tag in tags.models.into_iter().take(MAX_OLLAMA_CLOUD_MODELS) {
        if let Some(alias) = ollama_cloud_alias(&tag.name) {
            let size = unique.entry(alias).or_default();
            *size = (*size).max(tag.size);
        }
    }
    let mut out: Vec<(String, u64)> = unique.into_iter().collect();
    // The catalog does not expose a quality or coding rank. A nonzero
    // published size is only a useful browsing hint; a zero value means the
    // provider did not report a comparable size, so keep those entries
    // deliberately unranked after known-size entries.
    out.sort_by(|(left_name, left_size), (right_name, right_size)| {
        match (*left_size > 0, *right_size > 0) {
            (true, true) => right_size
                .cmp(left_size)
                .then_with(|| left_name.cmp(right_name)),
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            (false, false) => left_name.cmp(right_name),
        }
    });
    Ok(out.into_iter().map(|(name, _)| name).collect())
}

/// Convert a hosted API identifier into the equivalent CLI cloud alias.
/// `foo:tag` becomes `foo:tag-cloud`; `foo` becomes `foo:cloud`. The function
/// is deliberately idempotent so an already-cloud name cannot acquire a
/// second suffix.
fn ollama_cloud_alias(hosted: &str) -> Option<String> {
    if !safe_ollama_model_name(hosted) {
        return None;
    }
    let cloud = if hosted.ends_with(":cloud") || hosted.ends_with("-cloud") {
        hosted.to_owned()
    } else if hosted.contains(':') {
        format!("{hosted}-cloud")
    } else {
        format!("{hosted}:cloud")
    };
    safe_ollama_model_name(&cloud).then_some(cloud)
}

fn safe_ollama_model_name(name: &str) -> bool {
    name.len() <= 200
        && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c))
        && !name.contains("://")
}

fn parse_ollama_catalog(stdout: &str) -> Vec<String> {
    let mut out: Vec<String> = stdout
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let name = columns.next()?;
            let digest = columns.next()?;
            // `ollama list` emits NAME, a short hexadecimal model id, then
            // size and modified columns. Requiring that id drops headers,
            // connection errors, and other non-table output before it can be
            // reused as a launch argument.
            let looks_like_digest = digest.len() >= 7 && digest.chars().all(|c| c.is_ascii_hexdigit());
            let safe_name = safe_ollama_model_name(name);
            // `ollama list` also shows cloud aliases (`foo:cloud`, `foo:tag-cloud`)
            // once used. They run remotely on the user's Ollama plan, so they
            // belong to Ollama Cloud, not to the free local route.
            let lower = name.to_ascii_lowercase();
            let cloud_alias = lower.ends_with(":cloud") || lower.ends_with("-cloud");
            (looks_like_digest && safe_name && !cloud_alias).then(|| name.to_string())
        })
        .collect();
    out.sort();
    out.dedup();
    out.truncate(1000);
    out
}

/// `opencode models --verbose` prints one `provider/model` header line per
/// model followed by a JSON object with its metadata, including `cost`. Keep
/// only models that cost nothing, on every provider, so a paid model the user
/// happens to have a key for (for example Google's) is never listed.
fn parse_opencode_free(stdout: &str) -> Vec<String> {
    fn is_header(line: &str) -> bool {
        let mut parts = line.splitn(2, '/');
        match (parts.next(), parts.next()) {
            (Some(p), Some(m)) => {
                !p.is_empty()
                    && p.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                    && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                    && !m.is_empty()
                    && m.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c))
            }
            _ => false,
        }
    }
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut body = String::new();
    let mut flush = |id: Option<String>, body: &mut String, out: &mut Vec<String>| {
        if let Some(id) = id {
            let free = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| {
                    let cost = v.get("cost")?;
                    let zero = |k: &str| cost.get(k).and_then(|x| x.as_f64()).map(|x| x == 0.0);
                    // Image, music and video generators can cost nothing yet
                    // cannot work as a coding agent: require text output.
                    let text_out = v
                        .pointer("/capabilities/output/text")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(true);
                    Some(zero("input")? && zero("output")? && text_out)
                })
                .unwrap_or(false);
            if free {
                out.push(id);
            }
        }
        body.clear();
    };
    for line in stdout.lines() {
        let t = line.trim();
        if is_header(t) {
            flush(current.take(), &mut body, &mut out);
            current = Some(t.to_string());
        } else if current.is_some() {
            body.push_str(line);
            body.push('\n');
        }
    }
    flush(current.take(), &mut body, &mut out);
    out.sort();
    out.dedup();
    out.truncate(1000);
    out
}

/// A model id with any cloud-alias suffix removed, lower-cased, so a catalog
/// name (`gpt-oss:120b`) and its CLI alias (`gpt-oss:120b-cloud`) compare equal.
pub fn bare_model_name(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    lower
        .strip_suffix("-cloud")
        .or_else(|| lower.strip_suffix(":cloud"))
        .unwrap_or(&lower)
        .to_string()
}

/// When an agent's pricing says "everything is paid unless listed", keep only
/// the listed models. Applied in the backend so a paid model can never reach
/// the catalog `start_session` validates against.
pub fn keep_free_models(list: Vec<String>, pricing: Option<&ModelPricing>) -> Vec<String> {
    match pricing {
        Some(p) if p.default.as_deref() == Some("paid") => list
            .into_iter()
            .filter(|id| p.free.iter().any(|f| bare_model_name(f) == bare_model_name(id)))
            .collect(),
        _ => list,
    }
}

/// `codex debug models` prints Codex's own JSON catalog. Only entries it
/// marks `"visibility": "list"` are user-facing, and every slug must be a
/// plain model id so it can never be read as a flag by `codex -m`. Codex's
/// order (recommended first) is kept.
fn parse_codex_catalog(stdout: &str) -> Vec<String> {
    #[derive(Deserialize)]
    struct Catalog {
        models: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        slug: String,
        #[serde(default)]
        visibility: Option<String>,
    }
    let Ok(catalog) = serde_json::from_str::<Catalog>(stdout.trim()) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    catalog
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref().map_or(true, |v| v.eq_ignore_ascii_case("list")))
        .map(|m| m.slug)
        .filter(|s| {
            s.len() <= 100
                && s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c))
        })
        .filter(|s| seen.insert(s.clone()))
        .take(200)
        .collect()
}

fn default_variant() -> Variant {
    Variant {
        id: "default".into(),
        label: "Default".into(),
        args: vec![],
        resumes_session: false, paid: false,
    }
}

/// Walks PATH (and PATHEXT on Windows, so a `.cmd` npm shim resolves the
/// same as an `.exe`) and returns the absolute path of the first match.
/// The PATH ezCLI searches and hands to every CLI it launches.
///
/// A process started from the Start menu or a desktop shortcut inherits
/// Explorer's PATH from login time, so a CLI installed afterwards (npm,
/// Claude's native installer, WinGet...) is invisible until the user signs out
/// and back in. That made ezCLI report installed CLIs as "not installed".
/// We therefore merge, in order and without duplicates:
///   1. the current machine then user PATH from the registry (what a newly
///      opened terminal gets),
///   2. standard per-user install folders of common CLI installers,
///   3. this process's inherited PATH as a fallback for one-off launchers.
///
/// Putting the fresh sources first matters when an update or reinstall leaves
/// an older executable in Explorer's login-time PATH.
pub fn effective_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for p in registry_paths() {
            dirs.extend(std::env::split_paths(&p));
        }
        dirs.extend(well_known_cli_dirs());
    }
    if let Some(p) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&p));
    }

    merge_path_dirs(dirs)
}

/// Remove empty and duplicate directory entries, then return a Windows PATH.
/// Kept separate from `effective_path` so tests can model a stale parent PATH
/// without touching the process environment or the registry.
pub(crate) fn merge_path_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> OsString {
    let mut seen = std::collections::HashSet::new();
    let unique: Vec<PathBuf> = dirs
        .into_iter()
        .filter(|d| !d.as_os_str().is_empty())
        .filter(|d| seen.insert(d.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()))
        .collect();
    std::env::join_paths(unique).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Machine then user `Path`, read fresh from the registry with %VARS% expanded.
/// This matches the environment composition used by a newly launched Windows
/// process, while allowing a new per-user entry to supplement the machine PATH.
#[cfg(windows)]
fn registry_paths() -> Vec<String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ};

    const MAX_PATH_VALUE_BYTES: u32 = 64 * 1024;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn read(root: HKEY, subkey: &str) -> Option<String> {
        let key = wide(subkey);
        let name = wide("Path");
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ; // expands %VARS%
        let mut bytes: u32 = 0;
        // SAFETY: first call only reports the size; second writes into a
        // buffer of exactly that many bytes.
        unsafe {
            RegGetValueW(root, PCWSTR(key.as_ptr()), PCWSTR(name.as_ptr()), flags, None, None, Some(&mut bytes))
                .ok()
                .ok()?;
            if bytes == 0 || bytes > MAX_PATH_VALUE_BYTES {
                return None;
            }
            let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
            let mut len = (buf.len() * 2) as u32;
            RegGetValueW(
                root,
                PCWSTR(key.as_ptr()),
                PCWSTR(name.as_ptr()),
                flags,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut len),
            )
            .ok()
            .ok()?;
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        }
    }
    [
        read(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        read(HKEY_CURRENT_USER, "Environment"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Per-user folders where popular CLI installers put their commands.
#[cfg(windows)]
fn well_known_cli_dirs() -> Vec<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut out = Vec::new();
    if let Some(appdata) = env("APPDATA") {
        out.push(appdata.join("npm")); // npm install -g
    }
    if let Some(home) = env("USERPROFILE") {
        out.push(home.join(".local").join("bin")); // Claude Code native installer
        out.push(home.join(".bun").join("bin"));
        out.push(home.join("scoop").join("shims"));
    }
    if let Some(local) = env("LOCALAPPDATA") {
        out.push(local.join("Microsoft").join("WinGet").join("Links"));
        out.push(local.join("pnpm"));
        out.push(local.join("Volta").join("bin"));
        out.push(local.join("Programs").join("Ollama")); // Ollama default
        // Antigravity CLI's installer puts agy.exe here and does not always
        // add it to PATH. (The Antigravity desktop app ships no CLI at all.)
        out.push(local.join("agy").join("bin"));
    }
    out
}

pub(crate) fn resolve_command_on_path(cmd: &str, path_env: &OsStr) -> Option<String> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };

    for dir in std::env::split_paths(&path_env) {
        for ext in &exts {
            let candidate: PathBuf = dir.join(format!("{}{}", cmd, ext));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub fn resolve_command(cmd: &str) -> Option<String> {
    let as_path = Path::new(cmd);
    if as_path.components().count() > 1 {
        return if as_path.is_file() {
            Some(cmd.to_string())
        } else {
            None
        };
    }

    let path_env = effective_path();
    resolve_command_on_path(cmd, &path_env)
}

pub fn describe(agents: &[AgentDef]) -> Vec<AgentOut> {
    agents
        .iter()
        .map(|a| {
            let resolved = resolve_command(&a.command);
            AgentOut {
                id: a.id.clone(),
                label: a.label.clone(),
                vendor: a.vendor.clone(),
                icon: a.icon.clone(),
                command: a.command.clone(),
                args: a.args.clone(),
                modes: a.modes.clone(),
                models: a.models.clone(),
                efforts: a.efforts.clone(),
                image_transport: image_transport(a).to_string(),
                available: resolved.is_some(),
                resolved,
                pc_control: a.mcp_style().is_some(),
                free: a.tier.as_deref().is_some_and(|t| t.eq_ignore_ascii_case("free")),
                dynamic_models: a.models_from.is_some(),
                catalog_available_without_command: a
                    .models_from
                    .as_ref()
                    .is_some_and(ModelsFrom::is_ollama_cloud),
                requires_model_selection: a
                    .models_from
                    .as_ref()
                    .is_some_and(|from| from.require_selection),
                install: a.install.clone(),
                model_pricing: a.model_pricing.clone(),
                group_chat: a.headless.is_some(),
                group_can_edit: a.headless.as_ref().is_some_and(|h| !h.edit.is_empty()),
                submit: a.submit.clone(),
            }
        })
        .collect()
}

/// Only ship recognised transport contracts to the UI. A manually edited
/// config remains usable for CLI launching, but it cannot make the UI promise
/// an attachment path that the backend/front end do not actually implement.
fn image_transport(a: &AgentDef) -> &'static str {
    match a.image_transport.as_deref() {
        Some("interactive_at_reference") => "interactive_at_reference",
        Some("initial_flag") => "initial_flag",
        Some("initial_positional") => "initial_positional",
        Some("clipboard_only") => "clipboard_only",
        _ => "none",
    }
}

/// Whether a model is a declared static option or a model that the backend
/// itself fetched from a catalog. Dynamic agents that require a selection must
/// use their catalog; their injected static `default` placeholder is not a
/// runnable model.
pub fn model_selection_is_valid(a: &AgentDef, model_id: &str, catalog: Option<&[String]>) -> bool {
    if a.models_from
        .as_ref()
        .is_some_and(|from| from.require_selection)
    {
        return catalog.is_some_and(|models| models.iter().any(|model| model == model_id));
    }
    a.models.iter().any(|model| model.id == model_id)
        || catalog.is_some_and(|models| models.iter().any(|model| model == model_id))
}

/// Build the launch argument list for a given effort/model/mode selection.
/// A model id that isn't one of the static variants is accepted only if it
/// appears in the catalog the backend itself fetched from the agent, so the
/// frontend still cannot inject an arbitrary argument. Global effort and model
/// flags deliberately precede a mode subcommand such as `codex resume`.
pub fn build_argv(
    a: &AgentDef,
    mode_id: &str,
    model_id: &str,
    effort_id: &str,
    catalog: Option<&[String]>,
) -> Vec<String> {
    let mut out = a.args.clone();
    if let Some(e) = a.efforts.iter().find(|v| v.id == effort_id) {
        out.extend(e.args.clone());
    }
    if let Some(m) = a.models.iter().find(|v| v.id == model_id) {
        out.extend(m.args.clone());
    } else if let (Some(from), Some(cat)) = (&a.models_from, catalog) {
        if cat.iter().any(|c| c == model_id) {
            if let Some(launch) = from.launch_args() {
                out.extend(launch.iter().cloned());
                out.push(model_id.to_string());
            }
        }
    }
    if let Some(m) = a.modes.iter().find(|v| v.id == mode_id) {
        out.extend(m.args.clone());
    }
    out
}

/// A command ready for either a PTY session or a short-lived catalog process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: String,
    pub args: Vec<String>,
}

#[cfg(windows)]
fn system_executable(relative: &str, fallback: &str) -> String {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let candidate = PathBuf::from(root).join("System32").join(relative);
    candidate
        .is_file()
        .then(|| candidate.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(not(windows))]
fn system_executable(_: &str, fallback: &str) -> String {
    fallback.to_string()
}

/// A `.cmd` has to pass through cmd.exe's command parser. `call` accepts the
/// shim and its arguments as separate argv tokens, even when the shim path has
/// spaces, but CMD still treats its control characters specially. Reject those
/// unusual paths/arguments instead of silently running a different command.
#[cfg(windows)]
fn cmd_safe_token(value: &str) -> bool {
    !value
        .chars()
        .any(|c| matches!(c, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '%' | '!' | '"' | '\r' | '\n' | '\0'))
}

#[cfg(not(windows))]
fn cmd_safe_token(_: &str) -> bool {
    true
}

/// portable-pty calls CreateProcessW directly on Windows, which cannot launch
/// a `.cmd`/`.bat` shim as an executable. npm installs its global CLIs as those
/// shims, so route them through the trusted system cmd.exe with `call`.
/// `call` accepts the shim path and its argv as separate tokens, including
/// paths with spaces on volumes where 8.3 aliases are disabled. The arguments
/// are still constrained to agents.json or a backend-validated model catalog.
pub fn launch_command(resolved: &str, args: &[String]) -> Result<LaunchCommand> {
    let lower = resolved.to_ascii_lowercase();
    if cfg!(windows) && lower.ends_with(".ps1") {
        let mut wrapped = vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            resolved.to_string(),
        ];
        wrapped.extend(args.iter().cloned());
        Ok(LaunchCommand {
            program: system_executable(r"WindowsPowerShell\v1.0\powershell.exe", "powershell.exe"),
            args: wrapped,
        })
    } else if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        if !cmd_safe_token(resolved) || args.iter().any(|arg| !cmd_safe_token(arg)) {
            anyhow::bail!(
                "This Windows .cmd launcher has a path or option that cmd.exe cannot safely run. Move the CLI to a path without &, |, <, >, (, ), ^, %, !, or quotes, then restart ezCLI."
            );
        }
        let mut wrapped = vec!["/d".to_string(), "/v:off".to_string(), "/c".to_string(), "call".to_string(), resolved.to_string()];
        wrapped.extend(args.iter().cloned());
        Ok(LaunchCommand {
            program: system_executable("cmd.exe", "cmd.exe"),
            args: wrapped,
        })
    } else {
        Ok(LaunchCommand {
            program: resolved.to_string(),
            args: args.to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Launch a `.cmd` shim through the exact production path (launch_command
    /// + portable-pty) and return everything it printed.
    #[cfg(windows)]
    fn run_shim_through_pty(dir_name: &str, args: &[&str]) -> String {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let dir = std::env::temp_dir().join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("echo-shim.cmd");
        std::fs::write(&shim, "@echo off\r\necho EZCLI_SHIM_RAN [%1] [%2]\r\n").unwrap();

        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let launch = launch_command(&shim.to_string_lossy(), &args).unwrap();
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new(&launch.program);
        cmd.args(&launch.args);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let out = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            String::from_utf8_lossy(&buf).into_owned()
        });
        let _ = child.wait();
        drop(pair.master);
        let text = out.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        text
    }

    #[test]
    #[cfg(windows)]
    fn cmd_shim_launches_from_a_plain_path() {
        let out = run_shim_through_pty("ezcli-shim-plain", &["--model", "opus"]);
        assert!(out.contains("EZCLI_SHIM_RAN [--model] [opus]"), "{out}");
    }

    /// npm installs global CLIs under %APPDATA%\npm, so a Windows username
    /// with a space puts a space in every shim path.
    #[test]
    #[cfg(windows)]
    fn cmd_shim_launches_from_a_path_with_a_space() {
        let out = run_shim_through_pty("ezcli shim spaced", &["--model", "opus"]);
        assert!(out.contains("EZCLI_SHIM_RAN [--model] [opus]"), "{out}");
    }

    #[test]
    #[cfg(windows)]
    fn merged_path_keeps_the_fresh_entry_and_deduplicates_case_insensitively() {
        let fresh = PathBuf::from(r"C:\Users\Jane Doe\AppData\Roaming\npm");
        let duplicate = PathBuf::from(r"c:\users\jane doe\appdata\roaming\npm\");
        let fallback = PathBuf::from(r"C:\Windows\System32");
        let merged = merge_path_dirs(vec![fresh.clone(), duplicate, fallback.clone()]);
        assert_eq!(std::env::split_paths(&merged).collect::<Vec<_>>(), vec![fresh, fallback]);
    }

    /// The PC-control config file lives under %TEMP%, which also contains the
    /// username, so a later argument with a space must survive intact too.
    #[test]
    #[cfg(windows)]
    fn quoted_argument_with_a_space_reaches_the_shim_intact() {
        let out = run_shim_through_pty("ezcli shim spaced arg", &["--mcp-config", r"C:\Users\John Smith\p1.json"]);
        assert!(out.contains(r#"EZCLI_SHIM_RAN [--mcp-config] ["C:\Users\John Smith\p1.json"]"#), "{out}");
    }

    fn def(command: &str, mcp: Option<&str>) -> AgentDef {
        AgentDef {
            id: "x".into(),
            label: "X".into(),
            vendor: String::new(),
            icon: String::new(),
            command: command.into(),
            args: vec![],
            modes: vec![],
            models: vec![],
            image_transport: None,
            efforts: vec![],
            mcp: mcp.map(Into::into),
            tier: None,
            models_from: None,
            install: None,
            model_pricing: None,
            headless: None,
            submit: None,
        }
    }

    #[test]
    fn catalog_parsing_keeps_only_provider_model_lines() {
        let out = "banner text\n\nopencode/deepseek-v4.1-flash-free\nopenrouter/meta-llama/llama-4:free\n  ollama/qwen3:8b  \nrm -rf /\n--flag/x\nhttp://evil/x\nopencode/deepseek-v4.1-flash-free\n";
        assert_eq!(
            parse_catalog(out),
            vec![
                "ollama/qwen3:8b".to_string(),
                "opencode/deepseek-v4.1-flash-free".to_string(),
                "openrouter/meta-llama/llama-4:free".to_string(),
            ]
        );
    }

    #[test]
    fn catalog_models_are_only_used_when_the_backend_fetched_them() {
        let mut a = def("opencode", Some("none"));
        a.models_from = Some(ModelsFrom {
            args: vec!["models".into()],
            flag: Some("-m".into()),
            launch: vec![],
            catalog: None,
            require_selection: false,
        });
        let cat = vec!["opencode/free-model".to_string()];
        assert_eq!(build_argv(&a, "x", "opencode/free-model", "default", Some(&cat)), vec!["-m", "opencode/free-model"]);
        // Not in the fetched catalog: ignored rather than passed through.
        assert!(build_argv(&a, "x", "--dangerous", "default", Some(&cat)).is_empty());
        assert!(build_argv(&a, "x", "opencode/free-model", "default", None).is_empty());
        assert!(model_selection_is_valid(
            &a,
            "opencode/free-model",
            Some(&cat)
        ));
        assert!(!model_selection_is_valid(&a, "--dangerous", Some(&cat)));
    }

    #[test]
    fn continuation_flag_uses_the_frontend_property_name() {
        let value = serde_json::to_value(Variant {
            id: "continue".into(),
            label: "Continue".into(),
            args: vec!["--continue".into()],
            resumes_session: true, paid: false,
        })
        .unwrap();
        assert_eq!(value["resumesSession"], true);
        assert!(value.get("resumes_session").is_none());
    }

    #[test]
    fn static_model_selection_rejects_an_unknown_saved_id() {
        let mut a = def("codex", Some("codex"));
        a.models = vec![Variant {
            id: "gpt-5".into(),
            label: "gpt-5".into(),
            args: vec!["-m".into(), "gpt-5".into()],
            resumes_session: false, paid: false,
        }];
        assert!(model_selection_is_valid(&a, "gpt-5", None));
        assert!(!model_selection_is_valid(&a, "stale-model", None));
    }

    #[test]
    fn ollama_catalog_keeps_only_verified_table_rows() {
        let from = ModelsFrom {
            args: vec!["list".into()],
            flag: None,
            launch: vec!["run".into()],
            catalog: Some("ollama".into()),
            require_selection: true,
        };
        let out = "NAME ID SIZE MODIFIED\nllama3.2:latest a80c4f17acd5 2.0 GB 2 days ago\nregistry.ollama.ai/acme/vision:latest deadbeef 4.1 GB yesterday\nError: could not connect to Ollama\n--not-a-model deadbeef 1 GB now\nhttp://not-a-model deadbeef 1 GB now\n";
        assert_eq!(
            parse_catalog_for(&from, out),
            vec![
                "llama3.2:latest".to_string(),
                "registry.ollama.ai/acme/vision:latest".to_string(),
            ]
        );
    }

    #[test]
    fn ollama_cloud_catalog_derives_exact_signed_in_cli_aliases() {
        let out = r#"{
          "models": [
            {"name":"gemma4:31b", "size":310},
            {"name":"gpt-oss:120b", "size":1200},
            {"name":"kimi-k2.7-code"},
            {"name":"gemma4:31b-cloud"},
            {"name":"https://not-a-model"},
            {"name":"--not-a-model"}
          ]
        }"#;
        assert_eq!(
            parse_ollama_cloud_catalog(out).unwrap(),
            vec![
                "gpt-oss:120b-cloud".to_string(),
                "gemma4:31b-cloud".to_string(),
                "kimi-k2.7-code:cloud".to_string(),
            ]
        );
    }

    #[test]
    fn ollama_cloud_catalog_rejects_invalid_or_oversized_data() {
        assert!(parse_ollama_cloud_catalog("not json").is_err());
        assert!(parse_ollama_cloud_catalog(&"x".repeat(MAX_OLLAMA_CLOUD_CATALOG_BYTES + 1)).is_err());
    }

    #[test]
    fn ollama_dynamic_model_uses_run_subcommand() {
        let mut a = def("ollama", Some("none"));
        a.models_from = Some(ModelsFrom {
            args: vec!["list".into()],
            flag: None,
            launch: vec!["run".into()],
            catalog: Some("ollama".into()),
            require_selection: true,
        });
        let cat = vec!["llama3.2:latest".to_string()];
        assert_eq!(
            build_argv(&a, "default", "llama3.2:latest", "default", Some(&cat)),
            vec!["run", "llama3.2:latest"]
        );
        assert!(build_argv(&a, "default", "--bad", "default", Some(&cat)).is_empty());
        assert!(model_selection_is_valid(&a, "llama3.2:latest", Some(&cat)));
        assert!(!model_selection_is_valid(&a, "default", Some(&cat)));
        assert!(!model_selection_is_valid(&a, "llama3.2:latest", None));
    }

    #[test]
    fn global_effort_and_model_flags_precede_a_mode_subcommand() {
        let mut a = def("codex", Some("codex"));
        a.args = vec!["--no-daemon".into()];
        a.efforts = vec![Variant {
            id: "high".into(),
            label: "High".into(),
            args: vec!["-c".into(), "model_reasoning_effort=\"high\"".into()],
            resumes_session: false, paid: false,
        }];
        a.models = vec![Variant {
            id: "gpt".into(),
            label: "GPT".into(),
            args: vec!["-m".into(), "gpt-5".into()],
            resumes_session: false, paid: false,
        }];
        a.modes = vec![Variant {
            id: "resume".into(),
            label: "Resume".into(),
            args: vec!["resume".into(), "--last".into()],
            resumes_session: true, paid: false,
        }];
        assert_eq!(
            build_argv(&a, "resume", "gpt", "high", None),
            vec![
                "--no-daemon",
                "-c",
                "model_reasoning_effort=\"high\"",
                "-m",
                "gpt-5",
                "resume",
                "--last"
            ]
        );
    }

    #[test]
    fn builtin_agents_are_merged_without_overriding_user_entries() {
        let mut user = vec![def("my-claude", None)];
        user[0].id = "claude-code".into();
        merge_builtin(&mut user);
        assert_eq!(user.iter().filter(|a| a.id == "claude-code").count(), 1);
        assert_eq!(user[0].command, "my-claude", "user's edit wins");
        for id in ["opencode", "antigravity", "gemini", "ollama", "ollama-cloud", "freebuff"] {
            assert!(user.iter().any(|a| a.id == id), "missing built-in {id}");
        }
    }

    #[test]
    fn google_and_local_builtin_routes_have_safe_declared_launches() {
        let mut user = vec![];
        merge_builtin(&mut user);

        let antigravity = user.iter().find(|a| a.id == "antigravity").unwrap();
        assert_eq!(antigravity.command, "agy");
        assert!(antigravity.args.is_empty());
        assert_eq!(antigravity.tier.as_deref(), Some("free"));
        assert_eq!(antigravity.image_transport.as_deref(), Some("clipboard_only"));

        let gemini = user.iter().find(|a| a.id == "gemini").unwrap();
        assert_eq!(gemini.tier, None);
        assert_eq!(gemini.image_transport.as_deref(), Some("interactive_at_reference"));

        let ollama = user.iter().find(|a| a.id == "ollama").unwrap();
        let from = ollama.models_from.as_ref().unwrap();
        assert_eq!(from.args, vec!["list"]);
        assert_eq!(from.launch, vec!["run"]);
        assert_eq!(from.catalog.as_deref(), Some("ollama"));
        assert!(from.require_selection);
        assert_eq!(ollama.image_transport.as_deref(), Some("initial_positional"));

        let cloud = user.iter().find(|a| a.id == "ollama-cloud").unwrap();
        let cloud_from = cloud.models_from.as_ref().unwrap();
        assert!(cloud_from.is_ollama_cloud());
        assert!(cloud_from.require_selection);
        assert_eq!(cloud_from.launch, vec!["run"]);
    }

    #[test]
    fn mcp_style_is_inferred_from_the_command_for_older_configs() {
        assert_eq!(def("claude", None).mcp_style(), Some(McpStyle::Claude));
        assert_eq!(def(r"C:\npm\claude.cmd", None).mcp_style(), Some(McpStyle::Claude));
        assert_eq!(def("codex", None).mcp_style(), Some(McpStyle::Codex));
        assert_eq!(def("chatgpt", None).mcp_style(), None);
    }

    #[test]
    fn explicit_mcp_field_wins_including_opt_out() {
        assert_eq!(def("claude", Some("none")).mcp_style(), None);
        assert_eq!(def("my-wrapper", Some("codex")).mcp_style(), Some(McpStyle::Codex));
    }

    #[test]
    fn claude_chat_never_inherits_claude_code_pc_control() {
        let mut chat = def("claude", Some("claude"));
        chat.id = "claude-chat".into();
        assert_eq!(chat.mcp_style(), None);
    }

    #[test]
    fn old_builtin_entries_receive_effort_options_without_replacing_commands() {
        let mut user = vec![def("claude", None)];
        user[0].id = "claude-code".into();
        merge_builtin(&mut user);
        assert!(user[0].efforts.iter().any(|e| e.id == "high"));
        assert_eq!(user[0].command, "claude");
        assert_eq!(user[0].install.as_deref(), Some("npm install -g @anthropic-ai/claude-code"));
    }

    #[test]
    fn codex_catalog_keeps_listed_safe_models_in_order() {
        let raw = r#"{"models":[
            {"slug":"gpt-6-luna","visibility":"list"},
            {"slug":"gpt-reserve","visibility":"hide"},
            {"slug":"gpt-5.6-terra","visibility":"list"},
            {"slug":"--yolo","visibility":"list"},
            {"slug":"gpt-6-luna","visibility":"list"},
            {"slug":"no-visibility-field"}
        ]}"#;
        assert_eq!(parse_codex_catalog(raw), vec!["gpt-6-luna", "gpt-5.6-terra", "no-visibility-field"]);
        assert!(parse_codex_catalog("not json").is_empty());
        let codex = { let mut u = vec![]; merge_builtin(&mut u); u.into_iter().find(|a| a.id == "codex").unwrap() };
        let from = codex.models_from.as_ref().expect("codex has a live catalog");
        assert_eq!(from.args, vec!["debug", "models"]);
        assert_eq!(parse_catalog_for(from, raw), vec!["gpt-6-luna", "gpt-5.6-terra", "no-visibility-field"]);
    }

    #[test]
    fn opencode_catalog_keeps_only_zero_cost_models() {
        let raw = "opencode/beam-free\n{\n  \"id\": \"beam-free\",\n  \"cost\": { \"input\": 0, \"output\": 0 }\n}\n\
                   google/gemini-2.5-pro\n{\n  \"cost\": { \"input\": 1.25, \"output\": 10 }\n}\n\
                   opencode/paid-one\n{\n  \"cost\": { \"input\": 0, \"output\": 3 }\n}\n\
                   openrouter/nvidia/nemotron:free\n{\n  \"cost\": { \"input\": 0, \"output\": 0 }\n}\n\
                   opencode/no-cost-field\n{\n  \"id\": \"x\"\n}\n\
                   google/veo-free\n{\n  \"cost\": { \"input\": 0, \"output\": 0 },\n  \"capabilities\": { \"output\": { \"text\": false, \"video\": true } }\n}\n";
        assert_eq!(parse_opencode_free(raw), vec!["opencode/beam-free", "openrouter/nvidia/nemotron:free"]);
    }

    #[test]
    fn free_filter_matches_cloud_aliases_and_drops_everything_else() {
        let pricing = ModelPricing {
            default: Some("paid".into()),
            free: vec!["gpt-oss:120b".into(), "gemma4:31b".into()],
            note: None,
        };
        let list = vec!["gpt-oss:120b-cloud".to_string(), "kimi-k3:cloud".to_string(), "gemma4:31b-cloud".to_string(), "minimax-m3:cloud".to_string()];
        assert_eq!(keep_free_models(list.clone(), Some(&pricing)), vec!["gpt-oss:120b-cloud", "gemma4:31b-cloud"]);
        // No pricing, or a free-by-default agent, keeps the whole list.
        assert_eq!(keep_free_models(list.clone(), None), list);
        let free_default = ModelPricing { default: Some("free".into()), free: vec![], note: None };
        assert_eq!(keep_free_models(list.clone(), Some(&free_default)), list);
        assert_eq!(bare_model_name("GPT-OSS:120b-cloud"), "gpt-oss:120b");
        assert_eq!(bare_model_name("kimi-k3:cloud"), "kimi-k3");
    }

    #[test]
    fn old_stock_opencode_config_gets_the_fixed_free_list_and_fresh_pricing() {
        // What v1.x wrote: only "default", the unfiltered catalog, no pricing.
        let mut old = vec![def("opencode", None)];
        old[0].id = "opencode".into();
        old[0].models = vec![Variant { id: "default".into(), label: "Default".into(), args: vec![], resumes_session: false, paid: false }];
        old[0].models_from = Some(ModelsFrom { args: vec!["models".into()], flag: Some("-m".into()), launch: vec![], catalog: None, require_selection: false });
        merge_builtin(&mut old);
        let ids: Vec<_> = old[0].models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"opencode/nemotron-3-ultra-free") && ids.contains(&"opencode/big-pickle"));
        assert_eq!(old[0].models_from.as_ref().unwrap().catalog.as_deref(), Some("opencode-free"));
        assert!(old[0].model_pricing.is_some());

        // A user who set their own models or command keeps them.
        let mut custom = vec![def("opencode", None)];
        custom[0].id = "opencode".into();
        custom[0].models = vec![Variant { id: "mine".into(), label: "Mine".into(), args: vec![], resumes_session: false, paid: false }];
        merge_builtin(&mut custom);
        assert_eq!(custom[0].models.len(), 1);

        // A stale pricing list in an old Ollama Cloud config is replaced.
        let mut stale = vec![def("ollama", None)];
        stale[0].id = "ollama-cloud".into();
        stale[0].model_pricing = Some(ModelPricing { default: Some("paid".into()), free: vec!["kimi-k3".into()], note: None });
        merge_builtin(&mut stale);
        let free = &stale[0].model_pricing.as_ref().unwrap().free;
        assert!(free.iter().any(|m| m == "gpt-oss:120b") && !free.iter().any(|m| m == "kimi-k3"));
    }

    #[test]
    fn local_ollama_list_excludes_cloud_aliases() {
        let raw = "NAME                    ID              SIZE      MODIFIED\n\
                   llama3.2:3b             a80c4f17acd5    2.0 GB    3 days ago\n\
                   kimi-k3:cloud           1f2e3d4c5b6a    -         2 hours ago\n\
                   gemma4:31b-cloud        9a8b7c6d5e4f    -         1 day ago\n";
        assert_eq!(parse_ollama_catalog(raw), vec!["llama3.2:3b"]);
    }

    #[test]
    fn old_stock_codex_models_move_to_the_live_catalog_but_custom_lists_stay() {
        let variant = |id: &str| Variant { id: id.into(), label: id.into(), args: vec![], resumes_session: false, paid: false };
        let mut stock = vec![def("codex", Some("codex"))];
        stock[0].id = "codex".into();
        stock[0].models = vec![variant("default"), variant("gpt-5-codex"), variant("gpt-5")];
        merge_builtin(&mut stock);
        assert!(stock[0].models_from.is_some());
        assert_eq!(stock[0].models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["default"]);

        let mut custom = vec![def("codex", Some("codex"))];
        custom[0].id = "codex".into();
        custom[0].models = vec![variant("default"), variant("my-finetune")];
        merge_builtin(&mut custom);
        assert!(custom[0].models_from.is_none());
        assert_eq!(custom[0].models.len(), 2);
    }

    #[test]
    fn ollama_and_freebuff_ship_model_price_labels() {
        let mut user = vec![];
        merge_builtin(&mut user);
        let price = |id: &str| user.iter().find(|a| a.id == id).and_then(|a| a.model_pricing.clone()).unwrap();
        assert_eq!(price("ollama").default.as_deref(), Some("free"));
        assert_eq!(price("freebuff").default.as_deref(), Some("free"));
        let cloud = price("ollama-cloud");
        assert_eq!(cloud.default.as_deref(), Some("paid"));
        assert!(cloud.free.iter().any(|m| m == "gpt-oss:120b"));
        // A stock config always takes the shipped pricing, so a stale copy can
        // never keep a now-paid model on offer; a custom command keeps its own.
        let mut old = vec![def("ollama", None)];
        old[0].id = "ollama-cloud".into();
        merge_builtin(&mut old);
        assert!(old[0].model_pricing.is_some());
        old[0].model_pricing = Some(ModelPricing { default: Some("free".into()), ..Default::default() });
        merge_builtin(&mut old);
        assert_eq!(old[0].model_pricing.as_ref().unwrap().default.as_deref(), Some("paid"));
        let mut custom = vec![def("my-ollama", None)];
        custom[0].id = "ollama-cloud".into();
        custom[0].model_pricing = Some(ModelPricing { default: Some("free".into()), ..Default::default() });
        merge_builtin(&mut custom);
        assert_eq!(custom[0].model_pricing.as_ref().unwrap().default.as_deref(), Some("free"));
    }

    #[test]
    fn custom_commands_do_not_receive_a_builtin_install_hint() {
        let mut user = vec![def("my-codex", None)];
        user[0].id = "codex".into();
        merge_builtin(&mut user);
        assert_eq!(user[0].install, None);
    }

    #[test]
    fn old_stock_gemini_free_marker_migrates_to_antigravity_route() {
        let mut user = vec![def("gemini", Some("none"))];
        user[0].id = "gemini".into();
        user[0].tier = Some("free".into());
        merge_builtin(&mut user);
        let gemini = user.iter().find(|a| a.id == "gemini").unwrap();
        assert_eq!(gemini.tier, None);
        assert_eq!(gemini.image_transport.as_deref(), Some("interactive_at_reference"));
        assert!(user.iter().any(|a| a.id == "antigravity" && a.tier.as_deref() == Some("free")));
    }

    #[test]
    fn custom_gemini_command_keeps_its_user_chosen_tier() {
        let mut user = vec![def("company-gemini", Some("none"))];
        user[0].id = "gemini".into();
        user[0].tier = Some("free".into());
        merge_builtin(&mut user);
        assert_eq!(user[0].tier.as_deref(), Some("free"));
    }

    #[test]
    fn image_transport_is_a_safelisted_runtime_capability() {
        let mut user = vec![def("claude", None)];
        user[0].id = "claude-code".into();
        merge_builtin(&mut user);
        assert_eq!(describe(&user)[0].image_transport, "clipboard_only");

        user[0].image_transport = Some("not-a-real-transport".into());
        assert_eq!(describe(&user)[0].image_transport, "none");
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shims_are_wrapped_for_the_native_pty() {
        let args = vec!["-m".into(), "opencode/free-model".into()];
        assert_eq!(
            launch_command(r"C:\npm\opencode.cmd", &args).unwrap(),
            LaunchCommand {
                program: system_executable("cmd.exe", "cmd.exe"),
                args: vec![
                    "/d".into(),
                    "/v:off".into(),
                    "/c".into(),
                    "call".into(),
                    r"C:\npm\opencode.cmd".into(),
                    "-m".into(),
                    "opencode/free-model".into(),
                ],
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn cmd_shims_reject_cmd_control_characters() {
        assert!(launch_command(r"C:\Users\Jane & Alex\AppData\Roaming\npm\agent.cmd", &[]).is_err());
        assert!(launch_command(r"C:\tools\agent.cmd", &["--model".into(), "bad%PATH%".into()]).is_err());
    }

    #[cfg(windows)]
    fn run_in_native_pty(launch: LaunchCommand) -> (portable_pty::ExitStatus, String) {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(launch.program);
        for arg in launch.args {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env_remove("NO_COLOR");
        command.env("FORCE_COLOR", "3");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        drop(pair.slave);
        let reader = std::thread::spawn(move || {
            let mut output = String::new();
            reader.read_to_string(&mut output).unwrap();
            output
        });
        let status = child.wait().unwrap();
        // Keep the ConPTY master alive until its child completes. Dropping it
        // before wait tears down the pseudo console and makes cmd.exe fail to
        // initialize; dropping it now lets the reader observe EOF.
        drop(pair.master);
        let output = reader.join().unwrap();
        (status, output)
    }

    #[cfg(windows)]
    #[test]
    fn batch_shim_runs_in_the_same_native_pty_as_an_agent() {
        let path = std::env::temp_dir().join(format!("ezcli-pty-shim-{}.cmd", std::process::id()));
        std::fs::write(&path, "@echo off\r\necho ezcli-pty-shim-ok\r\n").unwrap();
        let launch = launch_command(&path.to_string_lossy(), &[]).unwrap();
        let (status, output) = run_in_native_pty(launch);
        let _ = std::fs::remove_file(&path);
        assert!(status.success(), "batch shim exited with {}: {output}", status.exit_code());
        assert!(output.contains("ezcli-pty-shim-ok"), "unexpected output: {output}");
    }

    /// Opt-in integration check for the exact Windows path the app uses.
    /// `scripts\test-rust.ps1 --ignored --nocapture real_opencode_pty`
    /// launches npm's opencode.cmd through a native ConPTY, but does not call
    /// a model or consume provider usage.
    #[cfg(windows)]
    #[test]
    #[ignore = "runs the installed OpenCode npm shim in a real native PTY"]
    fn real_opencode_cmd_shim_starts_in_native_pty() {
        let resolved = resolve_command("opencode").expect("opencode on PATH");
        assert!(resolved.to_ascii_lowercase().ends_with(".cmd"));
        let launch = launch_command(&resolved, &["--version".into()]).unwrap();
        let (status, output) = run_in_native_pty(launch);
        assert!(status.success(), "opencode exited with {}: {output}", status.exit_code());
        assert!(output.chars().any(|c| c.is_ascii_digit()), "unexpected output: {output}");
    }
}
