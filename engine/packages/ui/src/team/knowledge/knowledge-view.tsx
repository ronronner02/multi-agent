import { WorkspaceBrowser, type BrowseProps } from "../workspace/workspace-view.js";

export function KnowledgeView(props: BrowseProps) {
  return <WorkspaceBrowser {...props} view="knowledge" />;
}
