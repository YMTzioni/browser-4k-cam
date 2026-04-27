
# Lecturer Mode — Feature Plan

Goal: extend the 4K Screen Recorder so university/school lecturers can run a full live lesson and ship a polished recording, without leaving the browser.

## New features

### 1. On-screen annotation overlay
A transparent drawing layer that sits on top of any shared tab/window/screen, captured in the recording.
- Pen, highlighter, eraser
- 6 preset colors + adjustable thickness
- Shapes: arrow, rectangle, ellipse, line
- Text tool (click to type a label)
- Laser pointer mode (strokes fade after ~1.5s — great for pointing)
- Undo / redo / clear-all
- Floating toolbar (draggable, auto-hides during idle)
- Hotkeys: P pen, H highlight, E eraser, L laser, T text, Z undo, ⇧Z redo, Esc clear

### 2. Whiteboard mode
A full-screen blank canvas you can record instead of (or alongside) a shared screen.
- White / blackboard / grid / dotted backgrounds
- Same drawing tools as annotation overlay
- Multiple pages with prev/next + page indicator
- Export pages to PDF after recording

### 3. Slide / Presenter mode
Drop in a PDF or images and present them inside the app.
- Upload PDF or multiple images
- Next/prev with arrow keys, Space, or clicker remote
- Thumbnail strip + jump-to-slide
- Annotations are saved per-slide
- Camera bubble + annotations are recorded over the slides

### 4. Lecture timer & pacing
- Big elapsed timer (toggle visible/hidden in recording)
- Optional countdown ("end in 50:00") with soft warning at 5 min, hard warning at 0
- Per-section markers: press M to drop a chapter marker; markers become chapter labels in the exported video filename and a separate `.chapters.txt` file

### 5. Live captions & transcript
- Web Speech API live captions (English + common languages)
- Captions burned-in (optional) or saved separately as `.vtt`
- Full transcript downloadable as `.txt` after recording
- Toggle caption position (top/bottom) and size

### 6. Camera enhancements for teaching
Building on the existing camera + background blur:
- Round / rectangle / full-frame shapes
- 4 size presets (S/M/L/XL) + drag to reposition, snap to corners
- "Document camera" preset: flips to a second camera (e.g. phone via virtual cam) for showing handwritten notes
- Mirror toggle

### 7. Audience interaction helpers
- Floating QR code overlay that points to a URL you type (e.g. a poll, Padlet, Google Form). Toggle on/off mid-lecture.
- Quick "Question parking lot" sticky-note panel — type questions during the lecture, they're appended to the transcript export.

### 8. Lesson export bundle
After stopping, offer a one-click bundle download (zip) containing:
- The video (existing)
- `transcript.txt`
- `captions.vtt`
- `chapters.txt`
- `whiteboard.pdf` (if used)
- `annotated-slides.pdf` (if slide mode used)

### 9. Hotkey cheat-sheet
A "?" button opens a modal listing every shortcut. Lecturers can keep teaching without hunting through menus.

## UI changes

- Add a left-side vertical "Tools" rail next to the existing ScreenRecorder card with: Annotate, Whiteboard, Slides, Timer, Captions, QR.
- Add a top-right "Lecturer Mode" toggle on the landing page that swaps the layout to a focused presenter view (recorder controls collapse to a small floating dock).
- New `/present` route for the immersive whiteboard + slides workspace; landing page gets a "Start lecture" button alongside the existing record button.

## Technical notes

- Annotation layer: a fixed-position `<canvas>` with `pointer-events` toggled per-tool, composited into the recording via an `OffscreenCanvas` + `captureStream()` mixed with the display stream using `MediaStreamTrackGenerator` where supported, else a `<canvas>` `drawImage` loop into a recording canvas (same approach already used for camera bubble).
- PDF rendering: `pdfjs-dist`.
- PDF export: `jspdf` (already lightweight).
- Live captions: `webkitSpeechRecognition` (Chrome/Edge); graceful fallback message on Firefox.
- Zip bundle: `jszip`.
- New files (planned):
  - `src/components/lecturer/AnnotationOverlay.tsx`
  - `src/components/lecturer/Whiteboard.tsx`
  - `src/components/lecturer/SlideDeck.tsx`
  - `src/components/lecturer/LectureTimer.tsx`
  - `src/components/lecturer/LiveCaptions.tsx`
  - `src/components/lecturer/QrOverlay.tsx`
  - `src/components/lecturer/ToolRail.tsx`
  - `src/hooks/useAnnotationCanvas.ts`
  - `src/hooks/useSpeechCaptions.ts`
  - `src/hooks/useLectureBundle.ts`
  - `src/pages/Present.tsx`
- Extend `ScreenRecorder.tsx` to mix the annotation canvas into the existing recording composition pipeline and to surface the lecture bundle on stop.

## Suggested build order

1. Annotation overlay + hotkeys + recording integration
2. Lecture timer + chapter markers
3. Whiteboard mode (reuses annotation engine)
4. Live captions + transcript export
5. Slide / presenter mode with PDF
6. QR overlay + question parking lot
7. Lesson export bundle (zip)
8. Lecturer Mode layout + `/present` route + hotkey cheat-sheet

Approve this and I'll start with step 1; we can ship the rest in follow-up rounds.
