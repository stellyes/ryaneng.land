# Central definition of which file extensions are accepted, and in which direction.
# Keep this in sync with tools/image-converter/app.js on the frontend.

# Formats that can be both decoded (read) and encoded (written).
BIDIRECTIONAL = {
    "jpg", "jpeg", "jpe", "jif", "jfif", "jfi",
    "png", "gif", "webp", "tiff", "tif",
    "psd", "bmp", "dib", "heif", "heic",
    "jp2", "j2k", "jpx", "jpm", "mj2",
}

# Formats that can only ever be a source (vector/document/camera-raw formats
# with no meaningful or feasible "write" path in an open-source pipeline).
SOURCE_ONLY = {
    "svg", "ai", "eps", "pdf",
    "raw", "arw", "cr2", "nrw", "k25",
}

ALL_SOURCE_FORMATS = BIDIRECTIONAL | SOURCE_ONLY
ALL_TARGET_FORMATS = BIDIRECTIONAL

# Normalize aliases to the canonical ImageMagick/tool name used internally.
EXTENSION_ALIASES = {
    "jpe": "jpg", "jif": "jpg", "jfif": "jpg", "jfi": "jpg",
    "tif": "tiff",
    "dib": "bmp",
    "heif": "heic",
    "j2k": "jp2", "jpx": "jp2", "jpm": "jp2", "mj2": "jp2",
}

RAW_EXTENSIONS = {"raw", "arw", "cr2", "nrw", "k25"}
VECTOR_DOC_EXTENSIONS = {"svg", "ai", "eps", "pdf"}
HEIC_EXTENSIONS = {"heic", "heif"}

# ImageMagick coder to force when writing, keyed by the (un-normalized)
# requested target extension. Forcing the coder explicitly avoids relying on
# ImageMagick's own extension sniffing for the more obscure extensions.
IM_CODER_FOR_TARGET = {
    "jpg": "jpg", "jpeg": "jpg", "jpe": "jpg", "jif": "jpg", "jfif": "jpg", "jfi": "jpg",
    "png": "png",
    "gif": "gif",
    "webp": "webp",
    "tiff": "tiff", "tif": "tiff",
    "psd": "psd",
    "bmp": "bmp", "dib": "bmp",
    "jp2": "jp2", "j2k": "jp2", "jpx": "jp2", "jpm": "jp2", "mj2": "jp2",
}

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard cap, keeps cost/DoS risk low


def normalize_extension(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    return EXTENSION_ALIASES.get(ext, ext)


def is_valid_source(ext: str) -> bool:
    return ext.lower().lstrip(".") in ALL_SOURCE_FORMATS


def is_valid_target(ext: str) -> bool:
    return ext.lower().lstrip(".") in ALL_TARGET_FORMATS
