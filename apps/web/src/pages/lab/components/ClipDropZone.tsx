import { useCallback, useRef, useState } from "react";

interface ClipDropZoneProps {
  onFiles: (files: File[]) => void;
  compact?: boolean;
}

export function ClipDropZone({ onFiles, compact }: ClipDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (list: FileList | null) => {
      if (!list) return;
      // .lrf (DJI low-res proxy) sidecars have no registered video/* MIME
      // type in any browser, so file.type comes back "" for them — allow by
      // extension too. use-perception-lab's addFiles pairs a .lrf with its
      // same-basename original (or analyzes it standalone if unpaired).
      const files = Array.from(list).filter(
        (f) => f.type.startsWith("video/") || f.name.toLowerCase().endsWith(".lrf"),
      );
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return (
    <div
      className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${
        dragOver
          ? "border-primary bg-primary/10"
          : "border-border hover:border-text-secondary"
      } ${compact ? "p-4" : "p-12"}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.lrf"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {!compact && <div className="text-3xl">🎬</div>}
      <p className="text-text-primary font-medium">
        {compact ? "+ Add more clips" : "Drop your clips here"}
      </p>
      {!compact && (
        <p className="text-sm text-text-secondary">
          Analyzed entirely on your machine — nothing uploads. Big files welcome.
        </p>
      )}
    </div>
  );
}
