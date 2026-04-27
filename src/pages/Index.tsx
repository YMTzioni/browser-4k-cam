import { Button } from "@/components/ui/button";
import { Presentation } from "lucide-react";
import { ScreenRecorder } from "@/components/ScreenRecorder";

const Index = () => {
  return (
    <main className="min-h-screen bg-[image:var(--gradient-bg)] flex flex-col items-center px-4 py-12 sm:py-20">
      <header className="text-center mb-12 max-w-2xl">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-secondary/60 border border-border/50 text-xs font-medium text-muted-foreground mb-6">
          <span className="size-2 rounded-full bg-primary animate-pulse" />
          Browser-based · No install required
        </div>
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-4 bg-gradient-to-b from-foreground to-foreground/60 bg-clip-text text-transparent">
          4K Screen Recorder
        </h1>
        <p className="text-lg text-muted-foreground">
          Capture your screen in stunning ultra-high definition with crystal-clear audio — right from your browser.
        </p>
        <div className="mt-6">
          <Button asChild variant="secondary" className="gap-2">
            <a href="/lecturer" target="_blank" rel="noopener noreferrer">
              <Presentation className="size-4" /> Open Lecturer Workspace
            </a>
          </Button>
        </div>
      </header>

      <ScreenRecorder />

      <footer className="mt-16 text-center text-xs text-muted-foreground max-w-md">
        Best on Chrome, Edge, Firefox or Opera. Recordings are processed locally — nothing leaves your device.
      </footer>
    </main>
  );
};

export default Index;
