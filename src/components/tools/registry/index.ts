import { ApplyPatchTool } from '@/components/tools/implementations/ApplyPatchTool';
import { AskUserTool } from '@/components/tools/implementations/AskUserTool';
import { ConnectorsTool } from '@/components/tools/implementations/ConnectorsTool';
import { CreateTool } from '@/components/tools/implementations/CreateTool';
import { DefaultTool } from '@/components/tools/implementations/DefaultTool';
import { EditTool } from '@/components/tools/implementations/EditTool';
import { ExecuteTool } from '@/components/tools/implementations/ExecuteTool';
import { ExitSpecModeTool } from '@/components/tools/implementations/ExitSpecModeTool';
import { FetchUrlTool } from '@/components/tools/implementations/FetchUrlTool';
import { GlobTool } from '@/components/tools/implementations/GlobTool';
import { GrepTool } from '@/components/tools/implementations/GrepTool';
import { IdeDiagnosticsTool } from '@/components/tools/implementations/IdeDiagnosticsTool';
import { LSTool } from '@/components/tools/implementations/LSTool';
import { ProposeMissionTool } from '@/components/tools/implementations/ProposeMissionTool';
import { ReadTool } from '@/components/tools/implementations/ReadTool';
import { SkillTool } from '@/components/tools/implementations/SkillTool';
import { StartMissionRunTool } from '@/components/tools/implementations/StartMissionRunTool';
import { TaskOutputTool } from '@/components/tools/implementations/TaskOutputTool';
import { TaskTool } from '@/components/tools/implementations/TaskTool';
import { TodoWriteTool } from '@/components/tools/implementations/TodoWrite';
import { ToolSearchTool } from '@/components/tools/implementations/ToolSearchTool';
import { WebSearchTool } from '@/components/tools/implementations/WebSearchTool';
import { ToolComponent } from '@/components/tools/registry/types';

const toolRegistry: Record<string, ToolComponent> = {
  Read: ReadTool,
  LS: LSTool,
  Create: CreateTool,
  Execute: ExecuteTool,
  Edit: EditTool,
  ApplyPatch: ApplyPatchTool,
  Grep: GrepTool,
  Glob: GlobTool,
  ExitSpecMode: ExitSpecModeTool,
  ProposeMission: ProposeMissionTool,
  StartMissionRun: StartMissionRunTool,
  getIdeDiagnostics: IdeDiagnosticsTool,
  TodoWrite: TodoWriteTool,
  WebSearch: WebSearchTool,
  FetchUrl: FetchUrlTool,
  Task: TaskTool,
  Skill: SkillTool,
  AskUser: AskUserTool,
  TaskOutput: TaskOutputTool,
  ToolSearch: ToolSearchTool,
  ConnectorSearch: ConnectorsTool,
};

export function getToolComponent(toolName: string): ToolComponent {
  return toolRegistry[toolName] || DefaultTool;
}

// eslint-disable-next-line no-barrel-files/no-barrel-files
export { DefaultTool };
// eslint-disable-next-line no-barrel-files/no-barrel-files
export type { ToolComponent, ToolComponentProps } from './types';
