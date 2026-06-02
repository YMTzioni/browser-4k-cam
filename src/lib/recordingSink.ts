type SaveResult = {
  savedToFile: boolean;
  previewUrl: string | null;
  bytesWritten: number;
};

export type RecordingSink = {
  mode: "file" | "memory";
  savedFileName: string;
  pushChunk: (chunk: Blob) => void;
  finalize: () => Promise<SaveResult>;
  abort: () => Promise<void>;
};

type CreateRecordingSinkOptions = {
  mimeType: string;
  fileNamePrefix: string;
};

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
};

const buildFileName = (prefix: string) => {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${ts}.webm`;
};

export const createRecordingSink = async ({
  mimeType,
  fileNamePrefix,
}: CreateRecordingSinkOptions): Promise<RecordingSink> => {
  const suggestedName = buildFileName(fileNamePrefix);
  const win = window as SavePickerWindow;

  try {
    if (!win.showSaveFilePicker) throw new Error("Save picker unavailable");
    const handle = await win.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: "WebM video",
          accept: { "video/webm": [".webm"] },
        },
      ],
      excludeAcceptAllOption: false,
    });
    const writable = await handle.createWritable();
    let bytesWritten = 0;
    let closed = false;
    let writeChain = Promise.resolve();

    return {
      mode: "file",
      savedFileName: suggestedName,
      pushChunk: (chunk) => {
        if (closed || chunk.size === 0) return;
        writeChain = writeChain.then(async () => {
          await writable.write(chunk);
          bytesWritten += chunk.size;
        });
      },
      finalize: async () => {
        if (closed) {
          return { savedToFile: true, previewUrl: null, bytesWritten };
        }
        await writeChain;
        await writable.close();
        closed = true;
        return { savedToFile: true, previewUrl: null, bytesWritten };
      },
      abort: async () => {
        if (closed) return;
        try {
          await writable.abort();
        } finally {
          closed = true;
        }
      },
    };
  } catch {
    const chunks: Blob[] = [];
    return {
      mode: "memory",
      savedFileName: suggestedName,
      pushChunk: (chunk) => {
        if (chunk.size > 0) chunks.push(chunk);
      },
      finalize: async () => {
        const blob = new Blob(chunks, { type: mimeType || "video/webm" });
        return {
          savedToFile: false,
          previewUrl: URL.createObjectURL(blob),
          bytesWritten: blob.size,
        };
      },
      abort: async () => {
        chunks.length = 0;
      },
    };
  }
};
