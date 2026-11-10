/**
 * Which containers may an operator upload, and does the page say the same thing? (night of 2026-11-09)
 *
 * Measured with the `file-type` this checkout actually installs (22.0.1) against files this host's ffmpeg wrote:

 *   out.mp4  -> video/mp4        allowed
 *   out.mov  -> video/quicktime  allowed
 *   out.avi  -> video/vnd.avi    **not** in the allowlist, which listed `video/x-msvideo`
 *   real.mkv -> video/matroska   **not** in the allowlist, which listed `video/x-matroska`
 *
 * `views/admin/upload.ejs:15` advertises "MP4, MOV, AVI, MKV" and the multer extension filter
 * (`routes/admin.js:71`) admits `.mp4 .mov .avi .mkv`, so the server told operators two of those four were fine,
 * let the file stream all the way in, and then refused it on the content check with
 * `The uploaded file is video/vnd.avi, not a supported video type (content-is-video/vnd.avi)`. The reason is a
 * rename in the detector's mime vocabulary - the shipping allowlist kept the old names.
 *
 * So the declared set lives in one place here: extensions, mimes (current and legacy names for the same
 * container, because a deployment on an older `file-type` sees the old strings), and the human sentence the page
 * renders. Device playability is a different question and is NOT answered here: nothing in this server checks that
 * a container is playable on a Roku, and that claim is recorded as NOT RUN rather than assumed.
 */

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

// Current name first, the legacy detector name beside it: `file-type` renamed Matroska and AVI, and a deployment
// pinned to an older release sees the old string for the same bytes.
const VIDEO_MIMES = [
    'video/mp4',
    'video/quicktime',
    'video/matroska',
    'video/x-matroska',
    'video/vnd.avi',
    'video/x-msvideo',
    'video/webm'
];
const IMAGE_MIMES = ['image/jpeg', 'image/png'];

function videoExtensions() {
    return [...VIDEO_EXTENSIONS];
}

function imageExtensions() {
    return [...IMAGE_EXTENSIONS];
}

function videoMimes() {
    return [...VIDEO_MIMES];
}

function imageMimes() {
    return [...IMAGE_MIMES];
}

/** "MP4, MOV, AVI, MKV" - derived, so the sentence cannot drift from the filter that admits the extension. */
function advertisedExtensions(extensions) {
    return extensions.map((ext) => ext.replace(/^\./, '').toUpperCase()).join(', ');
}

function videoLabel() {
    return `a supported video type (${advertisedExtensions(VIDEO_EXTENSIONS)})`;
}

function imageLabel() {
    return `a supported image (${advertisedExtensions(IMAGE_EXTENSIONS)})`;
}

module.exports = {
    videoExtensions,
    imageExtensions,
    videoMimes,
    imageMimes,
    advertisedExtensions,
    videoLabel,
    imageLabel
};

// MUTATION-ANCHOR-UPLOAD-FORMATS: do not edit. The mutation check for `tests/unit/test-upload-formats.mjs` removes
// `video/vnd.avi` from `VIDEO_MIMES` (M1) and `video/matroska` from `VIDEO_MIMES` (M2), and the control uses an
// anchor absent on purpose, which must print `NO-IDENTICAL` rather than pass.
