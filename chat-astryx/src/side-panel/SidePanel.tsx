import { Dialog } from "@astryxdesign/core/Dialog";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
// The artifact card in replies opens artifacts here, so it registers with the panel.
import "../artifacts/register";
import DocumentView from "../artifacts/DocumentView";
import { useStore } from "../lib/store";
import { panelHeader } from "./header";
import PanelToolbar from "./PanelToolbar";
import { closePanel, fileKind, panel, type PanelItem } from "./panel";

/**
 * The panel at the right of the chat, for a file or an artifact. On a wide screen it sits
 * beside the chat and its width can be dragged; on a narrower one it covers the page.
 * Mount it once, in the shell's row. pdf.js loads the first time a PDF opens, not with the app.
 */
const PdfPages = lazy(() => import("./PdfPages"));
// The rarer views load when first opened too. A document is drawn as replies are, so it stays.
const HtmlView = lazy(() => import("../artifacts/HtmlView"));
const PresentMode = lazy(() => import("../artifacts/PresentMode"));
const SlidesView = lazy(() => import("../artifacts/SlidesView"));
const TableView = lazy(() => import("./TableView"));

export default function SidePanel() {
	const item = useStore(panel);
	const narrow = useMediaQuery("(max-width: 1023px)");
	if (!item) return null;

	// Keyed by the item, so a new file or artifact starts at the top with its own state.
	const view = <PanelView key={item.key} item={item} narrow={narrow} />;
	const title = panelHeader(item, null)?.title;
	if (narrow)
		return (
			<Dialog isOpen onOpenChange={(open) => !open && closePanel()} variant="fullscreen" aria-label={title}>
				{view}
			</Dialog>
		);
	return <WidePanel title={title}>{view}</WidePanel>;
}

/** Beside the chat, with a handle to drag its width. Only mounted on a wide screen, so a phone's width is never saved. */
function WidePanel({ title, children }: { title?: string; children: ReactNode }) {
	const width = useResizable({ defaultSize: "46%", minSize: 380, maxSize: 880, autoSaveId: "ponder-side-panel" });
	return (
		<>
			<ResizeHandle isReversed hasDivider resizable={width.props} label="Resize the side panel" />
			<LayoutPanel resizable={width.props} hasDivider={false} padding={0} isScrollable={false} role="complementary" label={title}>
				{children}
			</LayoutPanel>
		</>
	);
}

function PanelView({ item, narrow }: { item: PanelItem; narrow: boolean }) {
	const artifact = item.type === "artifact" ? item.artifact : null;
	const file = item.type === "file" ? item.file : null;
	const kind = file ? fileKind(file.mediaType, file.name) : null;
	const [rows, setRows] = useState<number | null>(null);
	const [presenting, setPresenting] = useState(false);
	// A web page shows its preview or its code. While the reply writes it, only the code.
	const [pageView, setPageView] = useState<"preview" | "code">("preview");
	const header = panelHeader(item, rows)!;
	const stopPresenting = useCallback(() => setPresenting(false), []);
	useEscapeToClose(!narrow && !presenting);

	const toolbar = (
		<PanelToolbar item={item} header={header} narrow={narrow} pageView={pageView} onPageView={setPageView} onPresent={() => setPresenting(true)} />
	);
	const body = (
		<div data-slot="side-panel-body" className={`h-full overflow-auto overscroll-contain ${header.inset ? "bg-muted" : ""}`}>
			<Suspense>
				{artifact?.kind === "document" ? (
					<DocumentView artifact={artifact} />
				) : artifact?.kind === "slides" ? (
					<SlidesView artifact={artifact} />
				) : artifact ? (
					<HtmlView artifact={artifact} view={pageView} />
				) : file && kind === "pdf" ? (
					<Suspense fallback={<PdfLoading />}>
						<PdfPages url={file.url} name={file.name} />
					</Suspense>
				) : file && kind === "table" ? (
					<TableView url={file.url} name={file.name} mediaType={file.mediaType} onRows={setRows} />
				) : file ? (
					<div className="flex min-h-full items-center justify-center p-4 sm:p-6">
						<img src={file.url} alt={file.name} className="max-h-[calc(100dvh-7rem)] max-w-full rounded-xl object-contain" />
					</div>
				) : null}
			</Suspense>
		</div>
	);
	const present = presenting && artifact && (
		<Suspense>
			<PresentMode artifact={artifact} onClose={stopPresenting} />
		</Suspense>
	);

	// Where the panel covers the page, it lays out as the dialog's header and content.
	if (narrow)
		return (
			<div data-slot="side-panel" className="contents">
				<Layout header={toolbar} content={<LayoutContent padding={0}>{body}</LayoutContent>} />
				{present}
			</div>
		);
	return (
		<div data-slot="side-panel" className="flex h-full min-h-0 flex-col bg-surface">
			{toolbar}
			<div className="min-h-0 flex-1">{body}</div>
			{present}
		</div>
	);
}

/** A page-shaped placeholder while pdf.js loads. */
function PdfLoading() {
	return (
		<div className="flex justify-center p-3 sm:p-6">
			<div className="aspect-[1/1.414] w-full max-w-[860px]">
				<Skeleton radius={3} />
			</div>
		</div>
	);
}

/** Escape closes the panel, unless something else uses the key: a field, a menu or a dialog. */
function useEscapeToClose(enabled: boolean) {
	useEffect(() => {
		if (!enabled) return;
		function onKeydown(event: KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const target = event.target as HTMLElement | null;
			if (target?.closest("input, textarea, select, [contenteditable], dialog, [role=dialog], [role=menu]")) return;
			closePanel();
		}
		addEventListener("keydown", onKeydown);
		return () => removeEventListener("keydown", onKeydown);
	}, [enabled]);
}
