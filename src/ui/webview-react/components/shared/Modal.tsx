import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { ExitButton } from "./ExitButton";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Extra content rendered between the title and the close button in the header. */
  headerActions?: React.ReactNode;
  /** Optional subtitle rendered on its own row below the title+actions row in the header. */
  headerSubtitle?: React.ReactNode;
  /** When true, the modal takes full width (no horizontal margin, no rounded corners) below the sm breakpoint. */
  fullWidthOnNarrow?: boolean;
  /** Overrides the body's padding classes. Defaults to "px-6 py-4". */
  bodyClassName?: string;
  /**
   * When true, render above the full-screen workspace viewer overlay
   * (z-workspace-viewer). Required for modals opened from inside the viewer,
   * otherwise the default modal layer renders behind it and stays invisible.
   */
  elevated?: boolean;
  /** Restore focus to the control that opened the modal when it closes. */
  restoreFocusOnClose?: boolean;
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
  bodyClassName = "px-6 py-4",
  elevated = false,
  restoreFocusOnClose = false,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
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
      if (
        restoreFocusOnClose &&
        document.activeElement instanceof HTMLElement
      ) {
        previousFocusRef.current = document.activeElement;
      }
      modalRef.current?.focus();
    } else if (restoreFocusOnClose) {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen, restoreFocusOnClose]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: "max-w-md",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
    full: "max-w-none w-full h-full rounded-none border-0",
  };
  const isFullScreen = size === "full";

  return createPortal(
    <>
      {/* Backdrop */}
      <button
        type="button"
        className={`fixed inset-0 ${backdropZ} flex items-center justify-center overflow-y-auto bg-black bg-opacity-50 border-0 p-0 cursor-default`}
        onClick={onClose}
        aria-label="Close modal backdrop"
      />
      {/* Modal content wrapper */}
      <div
        className={`fixed inset-0 ${contentZ} ${isFullScreen ? "flex flex-col overflow-hidden" : "flex items-center justify-center overflow-y-auto"} pointer-events-none`}
      >
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events,jsx-a11y/no-noninteractive-element-interactions -- stopPropagation only, no action triggered */}
        <div
          ref={modalRef}
          className={`relative w-full ${sizeClasses[size]} ${isFullScreen ? "flex flex-col" : fullWidthOnNarrow ? "sm:mx-4 sm:rounded-lg" : "mx-4 rounded-lg"} bg-editor-bg shadow-xl ${isFullScreen ? "border-0" : "border border-panel-border"} pointer-events-auto`}
          onClick={(e) => e.stopPropagation()}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          {/* Header */}
          <div className="flex-shrink-0 px-6 py-4 border-b border-panel-border">
            <div className="flex items-center justify-between">
              <h2
                id={titleId}
                className="text-xl font-semibold text-foreground"
              >
                {title}
              </h2>
              <div className="flex items-center gap-2">
                {headerActions}
                <ExitButton onClick={onClose} aria-label="Close modal" />
              </div>
            </div>
            {headerSubtitle && (
              <div className="mt-1 text-sm text-description-fg truncate">
                {headerSubtitle}
              </div>
            )}
          </div>

          {/* Body */}
          <div
            className={`${isFullScreen ? "flex-1 min-h-0 overflow-y-auto" : "max-h-[70vh] overflow-y-auto"} ${bodyClassName} text-foreground`}
          >
            {children}
          </div>

          {/* Footer */}
          {footer && (
            <div className="flex-shrink-0 flex items-center justify-end gap-1 overflow-x-auto px-2 py-3 border-t border-panel-border sm:gap-3 sm:px-6 sm:py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  );
};
