/** Shared option data accepted by the webview's CustomSelect component. */
export interface SelectOption {
  value: string;
  label: string;
  /** Optional compact label used in badges where the full label is too long. */
  short?: string;
  /** Optional muted secondary text rendered below the label in the menu. */
  description?: string;
  /** Extra tooltip-only text, shown after the description (e.g. a saved location). */
  tooltipDetail?: string;
  /** Optional className override for the secondary text. */
  descriptionClassName?: string;
  disabled?: boolean;
  /** Schema path used to add property-aware title and accessible text. */
  schemaPath?: string;
  /** YAML emitted by an option that is a UI-only sentinel rather than a schema value. */
  pseudo?: { writes: string } | { omit: true };
}
