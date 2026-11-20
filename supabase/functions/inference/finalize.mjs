import { insist, verifyParts } from './validation.mjs';

// Storage may complete an operation even when its response is interrupted.
// Recheck the object before retrying multipart completion or queueing anything.
export async function finalizeUpload(job, storage) {
  let size = await storage.head();
  if (size === null) {
    const parts = await storage.parts();
    verifyParts(parts, job.size_bytes);
    try {
      await storage.complete(parts);
    } catch (error) {
      let recovered;
      try { recovered = await storage.head(); } catch { throw error; }
      if (recovered !== job.size_bytes) throw error;
      return;
    }
    size = await storage.head();
  }
  insist(size === job.size_bytes, 409, 'Uploaded size differs from the declared size.');
}
