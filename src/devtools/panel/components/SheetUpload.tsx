export interface SheetUploadProps {
  readonly onFile: (file: File) => void;
  readonly fileName: string | undefined;
  readonly error: string | undefined;
}

export function SheetUpload({ onFile, fileName, error }: SheetUploadProps) {
  return (
    <section className="upload">
      <label className="upload__label">
        <span>Event Sheet</span>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              onFile(file);
            }
          }}
        />
      </label>
      {fileName !== undefined ? <p className="upload__file">Loaded {fileName}</p> : null}
      {error !== undefined ? (
        <p className="upload__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
