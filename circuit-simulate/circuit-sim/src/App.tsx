import { useState } from "react";
import { Toolbar } from "./components/Toolbar";
import { ComponentPalette } from "./components/ComponentPalette";
import { SchematicCanvas } from "./canvas/SchematicCanvas";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { SimulationPanel } from "./components/SimulationPanel";
import { CircuitJsViewer } from "./components/CircuitJsViewer";
import { useCircuitStore } from "./store/circuitStore";

export type ViewMode = "canvas" | "circuitjs";

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");
  const netlistRaw = useCircuitStore((s) => s.netlistRaw);

  return (
    <div className="app-shell">
      <div className="app-titlebar">
        <Toolbar viewMode={viewMode} onViewModeChange={setViewMode} />
      </div>
      <div className="app-palette">
        <ComponentPalette />
      </div>
      <div className="app-canvas-area">
        {viewMode === "canvas" ? (
          <SchematicCanvas />
        ) : (
          <CircuitJsViewer netlistJson={netlistRaw} />
        )}
      </div>
      <div className="app-inspector">
        <PropertiesPanel />
        <SimulationPanel />
      </div>
    </div>
  );
}
