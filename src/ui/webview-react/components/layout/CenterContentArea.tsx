import React from "react";
import { OutputSection, EditorSection } from "./index";

/**
 * CenterContentArea Component
 *
 * Renders the center panel containing Output and Editor sections.
 * Features:
 * - Background FlightPath logo visible when both panels are collapsed
 * - Relative positioning for absolute logo positioning
 */
export const CenterContentArea: React.FC = () => {
  // Get logo URL from body data attribute
  const logoUrl = document.body.getAttribute("data-logo-uri") || "";

  return (
    <div className="relative w-full h-full bg-[var(--bg-primary)] flex flex-col overflow-hidden">
      {/* Background logo - uses CSS mask to apply foreground color to SVG */}
      <div
        className="background-logo"
        style={{
          WebkitMaskImage: logoUrl ? `url('${logoUrl}')` : "none",
          maskImage: logoUrl ? `url('${logoUrl}')` : "none",
        }}
        aria-hidden="true"
      />

      {/* Output and Editor sections (rendered as collapsed PanelBars) */}
      <div className="relative z-10 w-full h-full flex flex-col">
        <OutputSection />
        <EditorSection />
      </div>
    </div>
  );
};
