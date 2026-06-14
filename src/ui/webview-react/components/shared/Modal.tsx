import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Extra content rendered between the title and the close button in the header. */
  headerActions?: React.ReactNode;
  /** Optional subtitle rendered on its own row below the title+actions row in the header. */
  headerSubtitle?: React.ReactNode;
  /** When true, the modal takes full width (no horizontal margin, no rounded corners) below the sm breakpoint. */
  fullWidthOnNarrow?: boolean;
  /**
   * When true, render above the full-screen workspace viewer overlay
   * (z-workspace-viewer). Required for modals opened from inside the viewer,
   * otherwise the default modal layer renders behind it and stays invisible.
   */
  elevated?: boolean;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = "md",
  headerActions,
  headerSubtitle,
  fullWidthOnNarrow = false,
  elevated = false,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const backdropZ = elevated ? "z-viewer-modal-backdrop" : "z-modal-backdrop";
  const contentZ = elevated ? "z-viewer-modal" : "z-modal";

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      // Focus trap
      modalRef.current?.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  };

  return createPortal(
    <>
      {/* Backdrop */}
      <button
        type="button"
        className={`fixed inset-0 ${backdropZ} flex items-center justify-center overflow-y-auto bg-black bg-opacity-50 border-0 p-0 bg-transparent cursor-default`}
        onClick={onClose}
        aria-label="Close modal backdrop"
      />
      {/* Modal content wrapper */}
      <div
        className={`fixed inset-0 ${contentZ} flex items-center justify-center overflow-y-auto pointer-events-none`}
      >
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-noninteractive-element-interactions -- stopPropagation only, no action triggered */}
        <div
          ref={modalRef}
          className={`relative w-full ${sizeClasses[size]} ${fullWidthOnNarrow ? "sm:mx-4 sm:rounded-lg" : "mx-4 rounded-lg"} bg-editor-bg shadow-xl border border-panel-border pointer-events-auto`}
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-panel-border">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-foreground">{title}</h2>
              <div className="flex items-center gap-1">
                {headerActions}
                <button
                  onClick={onClose}
                  className="text-description-fg hover:text-foreground transition-colors"
                  aria-label="Close modal"
                >
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
            {headerSubtitle && (
              <div className="mt-1 text-sm text-description-fg truncate">
                {headerSubtitle}
              </div>
            )}
          </div>

          {/* Body */}
          <div className="px-6 py-4 max-h-[70vh] overflow-y-auto text-foreground">
            {children}
          </div>

          {/* Footer */}
          {footer && (
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-panel-border">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
};
