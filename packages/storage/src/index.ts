export {
  createR2Client,
  getR2Bucket,
  getR2Client,
  resolveR2Config,
  buildR2Endpoint,
  _resetR2ClientForTests,
  _setR2ClientForTests,
  type R2Config,
} from './client.js';

export {
  accountAvatar,
  channelAvatar,
  channelBanner,
  bookPromoImage,
  bookArtifact,
  catalogSnapshot,
  chapterDraft,
  dbBackup,
  jobsArchive,
  kdpScreenshot,
  softDeletedKey,
  type BookArtifactKind,
} from './keys.js';

export { sha256Hex, sha256HexFromStream } from './hash.js';

export {
  deleteObject,
  downloadBuffer,
  getObjectMetadata,
  getSignedDownloadUrl,
  uploadBuffer,
  uploadStream,
  type ObjectMetadata,
  type OperationOptions,
  type UploadResult,
} from './operations.js';
