// Retained destinations use the numeral card layout.
// Project is the only card with the washed/inky look; the rest use
// sharp text.
//
// Column layout: Col 1 left-[5%], Col 2 left-[36%], Col 3 left-[67%]
// Row layout:    Top row top-[22%], Bottom row top-[55%]
//
// librarySize prop wires the Library card body to the live artifact
// count. Lab default keeps the static "field catalog 0.3.1" copy.

import { Folder, FileText, Cog } from "lucide-react";
import { VellumDestinationCard } from "./VellumDestinationCard.js";
import {
  StratigraphicGraphic,
  SphereGraphic,
  GearGraphic,
} from "./graphics.js";

interface DestinationsLayerProps {
  librarySize?: number;
}

export function DestinationsLayer({ librarySize }: DestinationsLayerProps = {}) {
  const libraryBody =
    librarySize && librarySize > 0
      ? `Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — ${librarySize} active artifacts.`
      : "Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — 38 active artifacts.";

  return (
    <div
      data-testid="destinations-layer"
      className="absolute inset-0 z-[18] pointer-events-none"
    >
      <VellumDestinationCard
        to="/project"
        num="02"
        big="02"
        label="Project"
        icon={<Folder className="h-4 w-4" />}
        body="Workspace · Mission · Slice. Browse all in-flight work by what agents are doing, not by repo."
        positionClass="top-[22%] left-[36%]"
        graphic={<StratigraphicGraphic />}
        layout="numeral"
        callouts={["WORKSPACE", "MISSION", "SLICE", "TASK"]}
        washed
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/specs"
        num="04"
        big="04"
        label="Library"
        icon={<FileText className="h-4 w-4" />}
        body={libraryBody}
        positionClass="top-[55%] left-[5%]"
        graphic={<SphereGraphic />}
        layout="numeral"
        callouts={["SPECS", "PLUGINS", "SKILLS", "PACKS"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/settings"
        num="06"
        big="06"
        label="Settings"
        icon={<Cog className="h-4 w-4" />}
        body="Config · Policy · Log · Status. Operator-grade controls; ConfigStore-backed; reversible."
        positionClass="top-[55%] left-[67%]"
        graphic={<GearGraphic />}
        layout="numeral"
        callouts={["CONFIG", "POLICY", "LOG", "STATUS"]}
        tint="stone"
        shadow="ambient"
      />
    </div>
  );
}
