/** Telegram message length limit (characters) */
export const TELEGRAM_MAX_LENGTH = 4096;

/** Supported MIME types for document uploads */
export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/html",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

/** Supported file extensions for document uploads */
export const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".html",
  ".js",
  ".ts",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
];

/** Max upload sizes */
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MB
export const MAX_VOICE_BYTES = 25 * 1024 * 1024; // 25 MB
