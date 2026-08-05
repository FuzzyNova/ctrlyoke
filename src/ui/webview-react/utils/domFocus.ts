export function isEditableElement(element: HTMLElement): boolean {
  const tagName = element.tagName;
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    Boolean(element.isContentEditable)
  );
}

export function isEditableElementFocused(): boolean {
  const activeElement = document.activeElement;
  return (
    activeElement instanceof HTMLElement && isEditableElement(activeElement)
  );
}
