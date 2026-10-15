//! Read-only screen capture for the PC-control `screenshot` tool.
//!
//! Captures the primary monitor with GDI, downscales it, and encodes PNG.
//! Callers must already have passed `lib.rs::pc_control_allowed`; this module
//! does no permission checks of its own.

use anyhow::{anyhow, Result};

/// Width cap for screenshots sent to a model. Image input is billed by pixel
/// area, so a full 4K frame would cost several times what a 1280-wide one does
/// for no extra legibility at typical UI text sizes.
pub const MAX_WIDTH: u32 = 1280;

pub struct Capture {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

/// Capture the primary monitor and return it as a downscaled PNG.
pub fn primary_screen() -> Result<Capture> {
    let (rgb, w, h) = grab_primary_rgb()?;
    let (rgb, tw, th) = downscale(&rgb, w, h, MAX_WIDTH);
    Ok(Capture {
        png: encode_png(&rgb, tw, th)?,
        width: tw,
        height: th,
        source_width: w,
        source_height: h,
    })
}

#[cfg(windows)]
fn grab_primary_rgb() -> Result<(Vec<u8>, u32, u32)> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    // SAFETY: plain GDI calls on handles created and released in this scope.
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err(anyhow!("no primary display"));
        }
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err(anyhow!("could not open the screen device context"));
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let previous = SelectObject(mem, bitmap.into());

        let blit = BitBlt(mem, 0, 0, w, h, Some(screen), 0, 0, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative = top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w as usize) * (h as usize) * 4];
        let lines = GetDIBits(
            mem,
            bitmap,
            0,
            h as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        blit.map_err(|e| anyhow!("screen copy failed: {e}"))?;
        if lines != h {
            return Err(anyhow!("screen read returned {lines} of {h} rows"));
        }

        let mut rgb = Vec::with_capacity((w as usize) * (h as usize) * 3);
        for px in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        Ok((rgb, w as u32, h as u32))
    }
}

#[cfg(not(windows))]
fn grab_primary_rgb() -> Result<(Vec<u8>, u32, u32)> {
    Err(anyhow!("screen capture is only implemented on Windows so far"))
}

/// Box-filter downscale of packed RGB to at most `max_w` wide, keeping aspect.
fn downscale(rgb: &[u8], w: u32, h: u32, max_w: u32) -> (Vec<u8>, u32, u32) {
    if w <= max_w {
        return (rgb.to_vec(), w, h);
    }
    let tw = max_w;
    let th = ((h as u64 * tw as u64 + w as u64 / 2) / w as u64).max(1) as u32;
    let mut out = Vec::with_capacity((tw * th * 3) as usize);
    for ty in 0..th {
        let y0 = (ty as u64 * h as u64 / th as u64) as u32;
        let y1 = (((ty + 1) as u64 * h as u64 / th as u64) as u32).max(y0 + 1);
        for tx in 0..tw {
            let x0 = (tx as u64 * w as u64 / tw as u64) as u32;
            let x1 = (((tx + 1) as u64 * w as u64 / tw as u64) as u32).max(x0 + 1);
            let mut sum = [0u64; 3];
            for y in y0..y1 {
                let row = (y * w) as usize * 3;
                for x in x0..x1 {
                    let i = row + x as usize * 3;
                    sum[0] += rgb[i] as u64;
                    sum[1] += rgb[i + 1] as u64;
                    sum[2] += rgb[i + 2] as u64;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u64;
            out.extend_from_slice(&[(sum[0] / n) as u8, (sum[1] / n) as u8, (sum[2] / n) as u8]);
        }
    }
    (out, tw, th)
}

fn encode_png(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgb)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_keeps_aspect_and_averages() {
        // 4x2 image: left half black, right half white -> 2x1 = [black, white].
        let mut rgb = Vec::new();
        for _y in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 0 } else { 255 };
                rgb.extend_from_slice(&[v, v, v]);
            }
        }
        let (out, w, h) = downscale(&rgb, 4, 2, 2);
        assert_eq!((w, h), (2, 1));
        assert_eq!(out, vec![0, 0, 0, 255, 255, 255]);
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let rgb = vec![10u8; 3 * 3 * 3];
        let (out, w, h) = downscale(&rgb, 3, 3, 1280);
        assert_eq!((w, h), (3, 3));
        assert_eq!(out, rgb);
    }

    #[test]
    fn png_round_trips() {
        let rgb: Vec<u8> = (0..(5 * 4 * 3)).map(|i| i as u8).collect();
        let bytes = encode_png(&rgb, 5, 4).unwrap();
        let decoder = png::Decoder::new(&bytes[..]);
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).unwrap();
        assert_eq!((frame.width, frame.height), (5, 4));
        assert_eq!(&buf[..frame.buffer_size()], &rgb[..]);
    }

    /// Opt-in: actually captures this machine's screen.
    /// `scripts\test-rust.ps1 --ignored --nocapture real_screen`
    #[test]
    #[ignore = "captures the real primary display"]
    fn real_screen_capture_is_a_valid_png() {
        let cap = primary_screen().unwrap();
        eprintln!(
            "captured {}x{} -> {}x{}, {} KB png",
            cap.source_width,
            cap.source_height,
            cap.width,
            cap.height,
            cap.png.len() / 1024
        );
        assert!(cap.width <= MAX_WIDTH);
        let mut reader = png::Decoder::new(&cap.png[..]).read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).unwrap();
        assert_eq!((frame.width, frame.height), (cap.width, cap.height));
        // A real desktop is never one flat colour.
        let first = &buf[0..3];
        assert!(buf[..frame.buffer_size()].chunks_exact(3).any(|px| px != first));
    }
}
