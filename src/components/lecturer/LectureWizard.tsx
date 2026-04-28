import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FileUp,
  Globe,
  Library,
  Trash2,
  ArrowRight,
  ArrowLeft,
  FileText,
  Link2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useContentLibrary, type LibraryItem, type LibraryPdf, type LibraryUrl, base64ToArrayBuffer } from "@/hooks/useContentLibrary";

export type WizardResult =
  | { kind: "pdf"; file: File; name: string }
  | { kind: "url"; url: string; name: string };

type Props = {
  onCancel?: () => void;
  onComplete: (result: WizardResult) => void;
};

type SourceKind = "pdf" | "url" | null;

/**
 * Step-by-step pre-recording wizard. Lets the lecturer pick a content source
 * (PDF or live URL) — either uploading new content or selecting from the
 * local library.
 */
export const LectureWizard = ({ onCancel, onComplete }: Props) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [sourceKind, setSourceKind] = useState<SourceKind>(null);
  const [urlValue, setUrlValue] = useState("");
  const [urlName, setUrlName] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { items, addPdf, addUrl, remove } = useContentLibrary();

  const pdfItems = items.filter((i): i is LibraryPdf => i.kind === "pdf");
  const urlItems = items.filter((i): i is LibraryUrl => i.kind === "url");

  const handlePdfFile = async (file: File, save: boolean) => {
    try {
      if (save) {
        await addPdf(file).catch((e: Error) => {
          toast.warning(e.message);
        });
      }
      onComplete({ kind: "pdf", file, name: file.name });
    } catch (err) {
      console.error(err);
      toast.error("Could not read this PDF");
    }
  };

  const handlePdfFromLibrary = (item: LibraryPdf) => {
    const buf = base64ToArrayBuffer(item.data);
    const file = new File([buf], item.name, { type: "application/pdf" });
    onComplete({ kind: "pdf", file, name: item.name });
  };

  const handleUrlSubmit = (save: boolean) => {
    let url = urlValue.trim();
    if (!url) {
      toast.error("Enter a URL");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try {
      new URL(url);
    } catch {
      toast.error("Invalid URL");
      return;
    }
    const name = urlName.trim() || new URL(url).hostname;
    if (save) addUrl(name, url);
    onComplete({ kind: "url", url, name });
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-classroom-muted-foreground mb-1">
            New lesson · Step {step} of 2
          </div>
          <h1 className="text-2xl font-bold text-classroom-surface-foreground">
            {step === 1 ? "Choose your content" : sourceKind === "pdf" ? "Pick a PDF" : "Enter a URL"}
          </h1>
        </div>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-classroom-muted-foreground">
            <X className="size-4 mr-1" /> Cancel
          </Button>
        )}
      </div>

      {/* Step 1 — pick source kind */}
      {step === 1 && (
        <div className="grid sm:grid-cols-2 gap-4">
          <SourceCard
            icon={<FileText className="size-6" />}
            title="PDF slides"
            description="Present and annotate a PDF document. Great for lectures and slides."
            tint="green"
            onClick={() => {
              setSourceKind("pdf");
              setStep(2);
            }}
          />
          <SourceCard
            icon={<Globe className="size-6" />}
            title="Live website"
            description="Share any URL inside the workspace. Good for demos, articles, or web tools."
            tint="blue"
            onClick={() => {
              setSourceKind("url");
              setStep(2);
            }}
          />
        </div>
      )}

      {/* Step 2 — PDF source */}
      {step === 2 && sourceKind === "pdf" && (
        <div className="space-y-4">
          <Card className="bg-classroom-surface border-classroom-border shadow-[var(--shadow-classroom)] p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-classroom-border flex items-center gap-2">
              <FileUp className="size-4 text-classroom" />
              <h2 className="text-sm font-semibold">Upload a new PDF</h2>
            </div>
            <div className="p-6">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePdfFile(f, true);
                }}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-classroom-border rounded-xl p-8 text-center cursor-pointer hover:border-classroom hover:bg-classroom/5 transition-colors"
              >
                <div className="size-12 rounded-full bg-classroom/10 grid place-items-center mx-auto mb-3">
                  <FileUp className="size-5 text-classroom" />
                </div>
                <div className="text-sm font-semibold">Choose a PDF file</div>
                <p className="text-xs text-classroom-muted-foreground mt-1">
                  It will be saved to your local library for next time.
                </p>
              </div>
            </div>
          </Card>

          {pdfItems.length > 0 && (
            <Card className="bg-classroom-surface border-classroom-border shadow-[var(--shadow-classroom)] p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-classroom-border flex items-center gap-2">
                <Library className="size-4 text-classroom-secondary" />
                <h2 className="text-sm font-semibold">Your saved PDFs ({pdfItems.length})</h2>
              </div>
              <ul className="divide-y divide-classroom-border">
                {pdfItems.map((item) => (
                  <LibraryRow
                    key={item.id}
                    icon={<FileText className="size-4 text-classroom" />}
                    title={item.name}
                    subtitle={`${(item.size / 1024 / 1024).toFixed(2)} MB · ${formatDate(item.addedAt)}`}
                    onUse={() => handlePdfFromLibrary(item)}
                    onRemove={() => remove(item.id)}
                  />
                ))}
              </ul>
            </Card>
          )}

          <BackBar onBack={() => setStep(1)} />
        </div>
      )}

      {/* Step 2 — URL source */}
      {step === 2 && sourceKind === "url" && (
        <div className="space-y-4">
          <Card className="bg-classroom-surface border-classroom-border shadow-[var(--shadow-classroom)] p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-classroom-border flex items-center gap-2">
              <Link2 className="size-4 text-classroom-secondary" />
              <h2 className="text-sm font-semibold">Share a website URL</h2>
            </div>
            <div className="p-6 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wiz-url" className="text-xs">URL</Label>
                <Input
                  id="wiz-url"
                  placeholder="https://example.com"
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  className="bg-classroom-surface border-classroom-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-name" className="text-xs">Display name (optional)</Label>
                <Input
                  id="wiz-name"
                  placeholder="My demo site"
                  value={urlName}
                  onChange={(e) => setUrlName(e.target.value)}
                  className="bg-classroom-surface border-classroom-border"
                />
              </div>
              <p className="text-[11px] text-classroom-muted-foreground">
                ⚠️ Some sites block embedding (X-Frame-Options). Recording a website uses screen-sharing and will prompt you to pick the tab.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  onClick={() => handleUrlSubmit(true)}
                  className="bg-classroom hover:bg-classroom/90 text-classroom-foreground gap-2"
                >
                  <ArrowRight className="size-4" /> Continue & save
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleUrlSubmit(false)}
                  className="border-classroom-border bg-classroom-surface hover:bg-classroom-muted"
                >
                  Use without saving
                </Button>
              </div>
            </div>
          </Card>

          {urlItems.length > 0 && (
            <Card className="bg-classroom-surface border-classroom-border shadow-[var(--shadow-classroom)] p-0 overflow-hidden">
              <div className="px-6 py-4 border-b border-classroom-border flex items-center gap-2">
                <Library className="size-4 text-classroom-secondary" />
                <h2 className="text-sm font-semibold">Your saved URLs ({urlItems.length})</h2>
              </div>
              <ul className="divide-y divide-classroom-border">
                {urlItems.map((item) => (
                  <LibraryRow
                    key={item.id}
                    icon={<Globe className="size-4 text-classroom-secondary" />}
                    title={item.name}
                    subtitle={item.url}
                    onUse={() => onComplete({ kind: "url", url: item.url, name: item.name })}
                    onRemove={() => remove(item.id)}
                  />
                ))}
              </ul>
            </Card>
          )}

          <BackBar onBack={() => setStep(1)} />
        </div>
      )}
    </div>
  );
};

const SourceCard = ({
  icon,
  title,
  description,
  tint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tint: "green" | "blue";
  onClick: () => void;
}) => {
  const tintBg = tint === "green" ? "bg-classroom/10 text-classroom" : "bg-classroom-secondary/10 text-classroom-secondary";
  return (
    <button
      onClick={onClick}
      className="text-left bg-classroom-surface border border-classroom-border rounded-xl p-6 shadow-[var(--shadow-classroom)] hover:shadow-[var(--shadow-classroom-lg)] hover:border-classroom transition-all group"
    >
      <div className={`size-12 rounded-lg grid place-items-center mb-4 ${tintBg}`}>{icon}</div>
      <div className="text-base font-semibold text-classroom-surface-foreground mb-1">{title}</div>
      <p className="text-sm text-classroom-muted-foreground">{description}</p>
      <div className="mt-4 text-sm font-medium text-classroom flex items-center gap-1 opacity-80 group-hover:opacity-100">
        Continue <ArrowRight className="size-4" />
      </div>
    </button>
  );
};

const LibraryRow = ({
  icon,
  title,
  subtitle,
  onUse,
  onRemove,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onUse: () => void;
  onRemove: () => void;
}) => (
  <li className="px-6 py-3 flex items-center gap-3 hover:bg-classroom-muted/50">
    <div className="size-9 rounded-lg bg-classroom-muted grid place-items-center shrink-0">{icon}</div>
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium text-classroom-surface-foreground truncate">{title}</div>
      <div className="text-xs text-classroom-muted-foreground truncate">{subtitle}</div>
    </div>
    <Button
      size="sm"
      onClick={onUse}
      className="bg-classroom hover:bg-classroom/90 text-classroom-foreground"
    >
      Use
    </Button>
    <Button
      size="sm"
      variant="ghost"
      onClick={onRemove}
      className="text-classroom-muted-foreground hover:text-destructive"
    >
      <Trash2 className="size-4" />
    </Button>
  </li>
);

const BackBar = ({ onBack }: { onBack: () => void }) => (
  <div className="flex">
    <Button variant="ghost" size="sm" onClick={onBack} className="text-classroom-muted-foreground">
      <ArrowLeft className="size-4 mr-1" /> Back
    </Button>
  </div>
);

const formatDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
