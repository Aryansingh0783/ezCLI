//! File browser and preview endpoints.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;

const MAX_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_DIR_ENTRIES: usize = 2000;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub dir: bool,
    pub size: Option<u64>,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub truncated: bool,
    pub entries: Vec<DirEntry>,
}

pub fn list_dir(dir: &str) -> Result<DirListing> {
    let p = PathBuf::from(dir);
    let p = p.canonicalize().map_err(|_| anyhow!("not a directory"))?;
    if !p.is_dir() {
        return Err(anyhow!("not a directory"));
    }

    let read = std::fs::read_dir(&p)?;
    let mut raw: Vec<DirEntry> = Vec::new();
    let mut counted: usize = 0;
    let mut truncated = false;

    for entry in read {
        counted += 1;
        if counted > MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = md.is_dir();
        raw.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            dir: is_dir,
            size: if is_dir { None } else { Some(md.len()) },
        });
    }

    raw.sort_by(|a, b| match (a.dir, b.dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    let parent = p.parent().and_then(|parent| {
        if parent == p {
            None
        } else {
            Some(parent.to_string_lossy().into_owned())
        }
    });

    Ok(DirListing {
        path: p.to_string_lossy().into_owned(),
        parent,
        truncated,
        entries: raw,
    })
}

#[derive(Serialize)]
pub struct FileContent {
    pub path: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub text: String,
}

pub fn read_file(path: &str) -> Result<FileContent> {
    let p = PathBuf::from(path);
    let p = p.canonicalize().map_err(|_| anyhow!("not a file"))?;
    if !p.is_file() {
        return Err(anyhow!("not a file"));
    }
    let md = p.metadata()?;
    let size = md.len();

    let read_len = (size as usize).min(MAX_PREVIEW_BYTES);
    let mut buf = vec![0u8; read_len];
    let mut f = std::fs::File::open(&p)?;
    // Short reads are legitimate from pipes but a plain file on the local
    // disk should always deliver the full `read_len` bytes we asked for.
    let mut filled = 0;
    while filled < read_len {
        match f.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    buf.truncate(filled);

    // A NUL byte in the first 8 KiB is the usual heuristic for "binary";
    // UTF-16 text files slip through this and will come back as text,
    // which is fine for the preview pane.
    let binary = buf.iter().take(8192).any(|&b| b == 0);
    let text = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&buf).into_owned()
    };

    Ok(FileContent {
        path: p.to_string_lossy().into_owned(),
        size,
        binary,
        truncated: size as usize > MAX_PREVIEW_BYTES,
        text,
    })
}
