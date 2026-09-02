import { Link } from "@tanstack/react-router";
import { memo, useRef } from "react";
import { useDismissable } from "../hooks/useDismissable";
import { type ReadingStatus, STATUS_OPTIONS } from "../lib/status";
import { Icon } from "./Icon";

export type LibraryBook = {
	_id: string;
	title: string;
	author?: string | null;
	series?: string | null;
	seriesIndex?: string | null;
	sectionCount?: number;
	createdAt?: number;
	updatedAt?: number;
};

type BookCardProps = {
	book: LibraryBook;
	coverUrl?: string;
	progressPercent: number | null;
	isDownloaded: boolean;
	isDownloading: boolean;
	isSelecting: boolean;
	isSelected: boolean;
	isMenuOpen: boolean;
	// The user's explicit choice (null = automatic, derived from progress).
	explicitStatus: ReadingStatus | null;
	onSetStatus: (bookId: string, status: ReadingStatus | null) => void;
	onToggleSelect: (bookId: string) => void;
	// null closes any open menu; a bookId opens that book's menu.
	onMenuOpenChange: (bookId: string | null) => void;
	onDeviceDownload: (bookId: string) => void;
	onRemoveDownload: (bookId: string) => void;
	onSaveEpub: (bookId: string, title: string) => void;
	onDelete: (bookId: string) => void;
	onAddToCollection: (bookId: string) => void;
	onEditDetails: (bookId: string) => void;
	onViewHistory: (bookId: string) => void;
};

// Memoized so a selection toggle or menu open/close re-renders only the
// affected cards, not the whole shelf — the props are all primitives plus
// stable (useCallback) handlers, so React.memo's shallow compare is exact.
function BookCardImpl({
	book,
	coverUrl,
	progressPercent,
	isDownloaded,
	isDownloading,
	isSelecting,
	isSelected,
	isMenuOpen,
	explicitStatus,
	onSetStatus,
	onToggleSelect,
	onMenuOpenChange,
	onDeviceDownload,
	onRemoveDownload,
	onSaveEpub,
	onDelete,
	onAddToCollection,
	onEditDetails,
	onViewHistory,
}: BookCardProps) {
	const menuShellRef = useRef<HTMLDivElement>(null);
	// Only the open card attaches the document listeners (open gates the hook).
	useDismissable(menuShellRef, isMenuOpen, () => onMenuOpenChange(null));
	const showProgressBadge = progressPercent !== null && progressPercent > 0;

	const guardSelect = (event: { preventDefault: () => void }) => {
		if (isSelecting) {
			event.preventDefault();
			onToggleSelect(book._id);
		}
	};

	return (
		<div
			className={`book-card group w-full ${isSelected ? "is-selected" : ""}`}
		>
			<Link
				className="block"
				to="/reader/$bookId"
				params={{ bookId: book._id }}
				onClick={guardSelect}
			>
				<div
					className={`book-cover-frame relative aspect-[2/3] w-full overflow-hidden ${
						coverUrl ? "has-cover" : ""
					}`}
				>
					{coverUrl ? (
						<div className="absolute inset-0 overflow-hidden">
							<img
								src={coverUrl}
								alt={book.title}
								className="h-full w-full object-cover"
							/>
						</div>
					) : (
						<div className="flex h-full w-full items-center justify-center bg-[var(--surface-2)] p-3">
							<span className="line-clamp-4 text-center font-[family-name:var(--font-display)] text-sm text-[var(--muted)]">
								{book.title}
							</span>
						</div>
					)}
					{showProgressBadge ? (
						<div className="progress-badge">{`${progressPercent}%`}</div>
					) : null}
					{isDownloaded ? (
						<div className="device-dot" title="On this device" />
					) : null}
					{isSelecting ? (
						<div
							className={`select-badge ${isSelected ? "is-selected" : ""}`}
							aria-hidden="true"
						>
							{isSelected ? <Icon name="check" size={13} /> : null}
						</div>
					) : null}
				</div>
			</Link>
			<div className="book-meta">
				<div className="book-text">
					<Link
						className="book-title text-sm font-semibold"
						to="/reader/$bookId"
						params={{ bookId: book._id }}
						onClick={guardSelect}
						title={book.title}
					>
						{book.title}
					</Link>
					<div className="book-author truncate text-xs text-[var(--muted)]">
						{book.author ?? "Unknown author"}
					</div>
				</div>
				<div className="book-menu-shell" ref={menuShellRef}>
					{/* Click-to-open only. Hover-open + click-toggle raced: the
					    pointer's own hover opened the menu and the click closed it
					    again — every touch tap (synthetic mouseenter precedes click)
					    and the occasional CI run hit it. Dismissal is outside-click
					    or Escape (useDismissable) — hover-out closed the menu the
					    moment the pointer dipped past its edge. */}
					<button
						type="button"
						className="icon-btn"
						onClick={(event) => {
							event.stopPropagation();
							onMenuOpenChange(isMenuOpen ? null : book._id);
						}}
					>
						<span className="sr-only">Open menu</span>
						<Icon name="dots-vertical" />
					</button>
					{isMenuOpen ? (
						// biome-ignore lint/a11y/noStaticElementInteractions: the click handler only stops card-navigation propagation; menu items are buttons
						// biome-ignore lint/a11y/useKeyWithClickEvents: see above
						<div
							className="menu book-menu"
							onClick={(event) => event.stopPropagation()}
						>
							{isDownloaded ? (
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										onMenuOpenChange(null);
										onRemoveDownload(book._id);
									}}
								>
									Remove download
								</button>
							) : (
								<button
									type="button"
									className="menu-item"
									disabled={isDownloading}
									onClick={() => {
										onMenuOpenChange(null);
										onDeviceDownload(book._id);
									}}
								>
									{isDownloading ? "Downloading…" : "Download to this device"}
								</button>
							)}
							<div className="menu-heading">Status</div>
							{STATUS_OPTIONS.map((option) => (
								<button
									type="button"
									key={option.key}
									className="menu-item is-checkable"
									onClick={() => {
										onMenuOpenChange(null);
										// Re-picking the current status clears it back to automatic.
										onSetStatus(
											book._id,
											explicitStatus === option.key ? null : option.key,
										);
									}}
								>
									<span className="menu-check">
										{explicitStatus === option.key ? (
											<Icon name="check" size={12} />
										) : null}
									</span>
									{option.label}
								</button>
							))}
							<div className="menu-heading">Manage</div>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									onMenuOpenChange(null);
									onViewHistory(book._id);
								}}
							>
								Reading history…
							</button>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									onMenuOpenChange(null);
									onEditDetails(book._id);
								}}
							>
								Edit details…
							</button>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									onMenuOpenChange(null);
									onAddToCollection(book._id);
								}}
							>
								Add to collection…
							</button>
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									onMenuOpenChange(null);
									onSaveEpub(book._id, book.title);
								}}
							>
								Save EPUB
							</button>
							<button
								type="button"
								className="menu-item is-danger"
								onClick={() => {
									onMenuOpenChange(null);
									onDelete(book._id);
								}}
							>
								Delete book
							</button>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

export const BookCard = memo(BookCardImpl);
