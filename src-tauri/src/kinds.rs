//! What a file on this computer is: its kind, from its name and its first bytes.
//!
//! The same table the server keeps for its own tree, so both tabs of Files choose a viewer by
//! the same word: `markdown` `code` `text` `html` `image` `svg` `pdf` `audio` `video` `table`
//! `notebook` `model3d` `archive` `binary`. **The bytes outrank the name**: a format with a
//! signature is what its first bytes say it is, whatever it is called, and a name that promises
//! such a format over bytes that are not it is plain `text` when they are text and `binary`
//! otherwise. A kind that is text comes from the extension, and holds only while the bytes are
//! text. `code` is not told from `text` here: the page does that by the name, with the table its
//! viewer already has.

/// How much of a file is looked at. A tar's signature sits at byte 257.
pub const HEAD_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kind {
    pub kind: &'static str,
    pub mime: &'static str,
}

const fn kind(kind: &'static str, mime: &'static str) -> Kind {
    Kind { kind, mime }
}

const BINARY: Kind = kind("binary", "application/octet-stream");
const TEXT: Kind = kind("text", "text/plain");

/// The extension of a name, lower case; none for a name that is only an extension (`.env`).
pub fn extension(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// UTF-8 without a NUL; a head cut in the middle of a character is still text.
pub fn looks_like_text(head: &[u8]) -> bool {
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 3 >= head.len(),
    }
}

/// The kind a signature gives, or None when the bytes carry none known here.
fn signature(head: &[u8], ext: &str) -> Option<Kind> {
    let at = |from: usize, to: usize| head.get(from..to).unwrap_or(&[]);
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(kind("image", "image/png"));
    }
    if head.starts_with(b"\xff\xd8\xff") {
        return Some(kind("image", "image/jpeg"));
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some(kind("image", "image/gif"));
    }
    if head.starts_with(b"RIFF") && head.len() >= 12 {
        return Some(match at(8, 12) {
            b"WEBP" => kind("image", "image/webp"),
            b"WAVE" => kind("audio", "audio/wav"),
            b"AVI " => kind("video", "video/x-msvideo"),
            _ => BINARY,
        });
    }
    if at(4, 8) == b"ftyp" && head.len() >= 12 {
        let brand = at(8, 12);
        return Some(match brand {
            b"avif" | b"avis" => kind("image", "image/avif"),
            b"M4A " | b"M4B " | b"M4P " => kind("audio", "audio/mp4"),
            // A picture no webview draws: a download.
            b"heic" | b"heix" | b"mif1" | b"msf1" => kind("binary", "image/heic"),
            b if b.starts_with(b"qt") => kind("video", "video/quicktime"),
            _ => kind("video", "video/mp4"),
        });
    }
    if head.starts_with(b"%PDF-") {
        return Some(kind("pdf", "application/pdf"));
    }
    if head.starts_with(b"\x1a\x45\xdf\xa3") {
        return Some(match ext {
            "weba" | "mka" => kind("audio", "audio/webm"),
            "mkv" => kind("video", "video/x-matroska"),
            _ => kind("video", "video/webm"),
        });
    }
    if head.starts_with(b"OggS") {
        return Some(match ext {
            "ogv" | "ogm" => kind("video", "video/ogg"),
            _ => kind("audio", "audio/ogg"),
        });
    }
    if head.starts_with(b"fLaC") {
        return Some(kind("audio", "audio/flac"));
    }
    if head.starts_with(b"ID3") {
        return Some(kind("audio", "audio/mpeg"));
    }
    // A frame sync is two bytes, too little to believe without the name.
    if head.len() >= 2
        && head[0] == 0xff
        && head[1] & 0xe0 == 0xe0
        && matches!(ext, "mp3" | "aac" | "mp2" | "mpga")
    {
        return Some(if ext == "aac" {
            kind("audio", "audio/aac")
        } else {
            kind("audio", "audio/mpeg")
        });
    }
    if head.starts_with(b"glTF") {
        return Some(kind("model3d", "model/gltf-binary"));
    }
    if head.starts_with(b"PK\x03\x04")
        || head.starts_with(b"PK\x05\x06")
        || head.starts_with(b"PK\x07\x08")
    {
        // A zip by its bytes -- and so is every office document, book and package. Only a file
        // called one is listed as one.
        return Some(if ext == "zip" {
            kind("archive", "application/zip")
        } else {
            BINARY
        });
    }
    if head.starts_with(b"\x1f\x8b") {
        return Some(kind("archive", "application/gzip"));
    }
    if head.starts_with(b"BZh") {
        return Some(kind("archive", "application/x-bzip2"));
    }
    if head.starts_with(b"\xfd7zXZ\x00") {
        return Some(kind("archive", "application/x-xz"));
    }
    if head.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Some(kind("archive", "application/x-7z-compressed"));
    }
    if at(257, 262) == b"ustar" {
        return Some(kind("archive", "application/x-tar"));
    }
    None
}

/// Extensions whose format has a signature: by the name alone they promise nothing.
const SIGNED: [&str; 59] = [
    "png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "pdf", "mp3", "wav", "ogg", "oga", "opus",
    "flac", "m4a", "aac", "weba", "mka", "mp4", "m4v", "mov", "webm", "mkv", "avi", "ogv", "glb",
    "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "stl", "docx", "xlsx", "pptx", "odt", "ods",
    "odp", "epub", "jar", "apk", "exe", "dll", "so", "bin", "iso", "dmg", "woff", "woff2", "ttf",
    "otf", "ico", "bmp", "tiff", "tif", "psd", "sqlite",
];

/// A text file's kind, by what it is called.
fn by_name(ext: &str) -> Kind {
    match ext {
        "md" | "markdown" => kind("markdown", "text/markdown"),
        "html" | "htm" => kind("html", "text/html"),
        "svg" => kind("svg", "image/svg+xml"),
        "csv" => kind("table", "text/csv"),
        "tsv" => kind("table", "text/tab-separated-values"),
        "ipynb" => kind("notebook", "application/x-ipynb+json"),
        "gltf" => kind("model3d", "model/gltf+json"),
        "obj" => kind("model3d", "model/obj"),
        _ => TEXT,
    }
}

/// The kind of a file called `name` whose first bytes are `head` (at most `HEAD_BYTES` of it; an
/// empty file is text by its name).
pub fn detect(name: &str, head: &[u8]) -> Kind {
    let ext = extension(name);
    let head = &head[..head.len().min(HEAD_BYTES)];
    if let Some(signed) = signature(head, &ext) {
        return signed;
    }
    if looks_like_text(head) {
        if ext == "stl" {
            return kind("model3d", "model/stl");
        }
        let blank = head.iter().all(|b| b.is_ascii_whitespace());
        if ext == "svg" && !blank && !head.contains(&b'<') {
            return TEXT;
        }
        // Called a picture (a film, an archive) and holding words.
        if SIGNED.contains(&ext.as_str()) || ext == "db" {
            return TEXT;
        }
        return by_name(&ext);
    }
    if ext == "stl" {
        // A binary STL has no signature: eighty bytes of anything, then a count.
        return kind("model3d", "model/stl");
    }
    BINARY
}

/// What a listing says of a file it has not opened: the kind its name promises. Enough to
/// choose an icon; whatever opens the file asks `detect` with its bytes.
pub fn by_name_alone(name: &str) -> &'static str {
    let ext = extension(name);
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" => "image",
        "pdf" => "pdf",
        "mp3" | "wav" | "ogg" | "oga" | "opus" | "flac" | "m4a" | "aac" | "weba" | "mka" => "audio",
        "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "ogv" => "video",
        "glb" | "stl" => "model3d",
        "zip" | "gz" | "tgz" | "tar" | "bz2" | "xz" | "7z" => "archive",
        e if SIGNED.contains(&e) || e == "db" => "binary",
        e => by_name(e).kind,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bytes_outrank_the_name() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(detect("notes.md", png).kind, "image");
        assert_eq!(detect("map.png", png).mime, "image/png");
        // A name that promises a picture over words is text, never a picture.
        assert_eq!(detect("map.png", b"<script>alert(1)</script>").kind, "text");
        assert_eq!(detect("page.html", b"<p>hello</p>").kind, "html");
        assert_eq!(detect("blob.dat", &[0u8, 1, 2, 3]).kind, "binary");
    }

    #[test]
    fn the_kinds_an_app_has_a_viewer_for() {
        assert_eq!(detect("a.svg", b"<svg xmlns='x'/>").kind, "svg");
        assert_eq!(detect("a.svg", b"just words").kind, "text");
        assert_eq!(detect("t.csv", b"a,b\n1,2\n").kind, "table");
        assert_eq!(detect("t.tsv", b"a\tb\n").mime, "text/tab-separated-values");
        assert_eq!(detect("n.ipynb", b"{\"cells\": []}").kind, "notebook");
        assert_eq!(detect("d.pdf", b"%PDF-1.7\n").kind, "pdf");
        assert_eq!(detect("s.mp3", b"ID3\x04\0\0").kind, "audio");
        assert_eq!(detect("s.ogg", b"OggS\0\x02").mime, "audio/ogg");
        assert_eq!(detect("f.ogv", b"OggS\0\x02").kind, "video");
        assert_eq!(detect("f.mp4", b"\0\0\0\x18ftypisom\0\0").mime, "video/mp4");
        assert_eq!(detect("f.m4a", b"\0\0\0\x18ftypM4A \0\0").kind, "audio");
        assert_eq!(detect("p.avif", b"\0\0\0\x18ftypavif\0\0").kind, "image");
        assert_eq!(detect("f.webm", b"\x1a\x45\xdf\xa3\x01").mime, "video/webm");
        assert_eq!(detect("m.glb", b"glTF\x02\0\0\0").kind, "model3d");
        assert_eq!(detect("m.stl", b"solid cube\n").kind, "model3d");
        assert_eq!(detect("a.zip", b"PK\x03\x04\x14\0").kind, "archive");
        assert_eq!(detect("a.docx", b"PK\x03\x04\x14\0").kind, "binary");
        assert_eq!(detect("a.tar.gz", b"\x1f\x8b\x08\0").kind, "archive");
        assert_eq!(detect("main.rs", b"fn main() {}\n").kind, "text");
        assert_eq!(detect("empty.md", b"").kind, "markdown");
    }

    #[test]
    fn a_head_cut_inside_a_character_is_still_text() {
        let text = "příliš žluťoučký kůň".as_bytes();
        assert!(looks_like_text(&text[..text.len() - 1]));
        assert!(!looks_like_text(b"\xff\xfe\x00a"));
        assert!(!looks_like_text(b"caf\xe9 au lait, and more after it"));
    }

    #[test]
    fn a_listing_goes_by_the_name() {
        assert_eq!(by_name_alone("map.PNG"), "image");
        assert_eq!(by_name_alone("song.flac"), "audio");
        assert_eq!(by_name_alone("clip.webm"), "video");
        assert_eq!(by_name_alone("data.csv"), "table");
        assert_eq!(by_name_alone("lib.so"), "binary");
        assert_eq!(by_name_alone("README"), "text");
        assert_eq!(by_name_alone(".env"), "text");
    }
}
