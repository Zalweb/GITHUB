export async function captureFrameAsBlob(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  quality = 0.8,
): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (!width || !height) {
    throw new Error("Video stream is not ready.");
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas context unavailable.");
  }

  ctx.drawImage(video, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });

  if (!blob) {
    throw new Error("Failed to capture frame blob.");
  }

  return blob;
}
