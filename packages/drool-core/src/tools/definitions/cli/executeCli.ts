import { z } from 'zod';

import {
  ToolExecutionLocation,
  TOOL_LLM_ID_EXECUTE,
} from '@industry/drool-sdk-ext/protocol/tools';

import { EXECUTE_CLI_TOOL_ID } from './constants';
import { ExecuteCliRuntimeShell } from './enums';
import { executeCliWithBackgroundSchema } from './schema';
import { createTool } from '../../create-tool';
import { SandboxSideEffect, Toolkit, ToolUIGroupId } from '../../enums';

const COMMIT_STEP_PLACEHOLDER = '{{COMMIT_STEP}}';
const PATH_QUOTING_PLACEHOLDER = '{{PATH_QUOTING_BLOCK}}';
const WORKING_DIR_PLACEHOLDER = '{{WORKING_DIR_BLOCK}}';
const TOOL_USAGE_SHELL_LINE_PLACEHOLDER = '{{TOOL_USAGE_SHELL_LINE}}';
const PYTHON_PKG_PLACEHOLDER = '{{PYTHON_PKG_BLOCK}}';
const ENV_VARS_PLACEHOLDER = '{{ENV_VARS_BLOCK}}';
const SECURITY_PLACEHOLDER = '{{SECURITY_BLOCK}}';
const RUNTIME_GUIDANCE_PLACEHOLDER = '{{RUNTIME_GUIDANCE}}';
const EXIT_CODE_FIDELITY_PLACEHOLDER = '{{EXIT_CODE_FIDELITY_BLOCK}}';

const TEMPLATE = `
Execute a shell command with optional timeout (in seconds).

CRITICAL: Each command runs in a NEW, ISOLATED shell process. Nothing persists between Execute calls:
- Environment variables are reset
- Virtual environment activations are lost
- Working directory changes are lost
- Installed packages remain, but PATH changes are lost

Before executing commands:

1. Directory Verification:
   - If creating new directories or files, first use the LS tool to verify the parent directory exists
   - Example: Before running "mkdir src/components/NewFeature", use LS to check that "src/components" exists

${PATH_QUOTING_PLACEHOLDER}
${WORKING_DIR_PLACEHOLDER}
Tool Usage Guidelines:
- Prefer the \`Read\` tool over running shell commands to view files
- Prefer the \`LS\` tool over running shell commands to list directories
- Prefer the \`Create\` tool over running shell commands to create new files
- Prefer the \`Edit\` and \`MultiEdit\` tools over running shell commands to modify files
- Prefer the \`Grep\` and \`Glob\` tools over running shell commands to search file contents and paths
- If you must run a search from the shell, use \`rg\` (ripgrep), which is pre-installed and faster than the equivalents on most systems
${TOOL_USAGE_SHELL_LINE_PLACEHOLDER}

Artifacts Directory Protection:
- NEVER create, edit, or delete files in ~/.industry/artifacts/ or its subdirectories
- This directory is reserved for system-generated outputs (e.g., full content for truncated tool results)
- You MAY read/view/analyze files in this directory if needed for analysis

${PYTHON_PKG_PLACEHOLDER}
${ENV_VARS_PLACEHOLDER}
Git Safety Guidelines:
- Always run 'git status' before other git commands
- Never use -i flag (interactive mode not supported)
- Never push without explicit user instruction
- Check changes with 'git diff' before committing
- Never update the git config unless user explicitly asks

Output Limits:
- Command output is truncated at 40,000 characters
- Long outputs will show truncation info

${EXIT_CODE_FIDELITY_PLACEHOLDER}
${SECURITY_PLACEHOLDER}
${RUNTIME_GUIDANCE_PLACEHOLDER}
Timeout:
- Default: 90 seconds
- Commands that exceed timeout will be terminated

Background processes (fireAndForget=true):
- The CLI prints PID and log file path on start.
- Read logs after delay in one command: \`sleep <s> && cat <file>\` (POSIX) or \`Start-Sleep <s>; Get-Content <file>\` (PowerShell). Use \`tail -n <N>\` or \`-Tail <N>\` for last N lines.
- Check status: \`ps -p <pid>\` (POSIX) or \`Get-Process -Id <pid>\` (PowerShell)
- Terminate: \`kill <pid>\` (POSIX) or \`Stop-Process -Id <pid>\` (PowerShell)

# Committing changes with git

When the user asks you to create a new git commit, follow these steps carefully:

1. Run these commands IN PARALLEL to understand the current state:
   - git status (to see all untracked files)
   - git diff (to see staged and unstaged changes)
   - git log --oneline -10 (to see recent commit messages and follow the repo's style)

2. Analyze all changes and draft a commit message:
   - Summarize the nature of changes (new feature, enhancement, bug fix, refactoring, test, docs)
   - Check for any sensitive information that shouldn't be committed
   - Draft a concise (1-2 sentences) commit message focusing on "why" rather than "what"

3. Execute the commit:
   - Add relevant untracked files to staging area
${COMMIT_STEP_PLACEHOLDER}
   - Run git status to confirm the commit succeeded

4. If the commit fails due to pre-commit hooks:
   - Retry ONCE to include automated changes
   - If it fails again, a pre-commit hook is likely preventing the commit
   - If files were modified by the pre-commit hook, amend your commit to include them

Important notes:
- Never update git config unless user explicitly asks
- Never use -i flag (interactive mode not supported)
- Don't push unless explicitly asked
- Don't create empty commits if there are no changes

# Creating pull requests

IMPORTANT: When the user asks you to create a pull request, follow these steps:

1. Run these commands IN PARALLEL to understand the branch state:
   - git status (to see all untracked files)
   - git diff (to see both staged and unstaged changes that will be committed)
   - git log (to see recent commit messages, so that you can follow this repository's commit message style)

2. Analyze ALL changes that will be included in the PR:
   - Look at ALL commits, not just the latest one
   - Understand the full scope of changes

3. Create the PR:
   - Create new branch if needed
   - Use the default branch (shown in the system info) as the base branch if the user didn't explicitly specify a base branch to use
   - Push to remote with -u flag if needed
   - Use gh pr create if available, otherwise provide instructions

Important:
- Never update git config unless user explicitly asks
- Return the PR URL when done
`;

const POSIX_PATH_QUOTING_BLOCK = `2. Path Quoting:
   Always quote file paths that contain spaces or special characters like '(', ')', '[', ']' with double quotes:
   CORRECT:
   - cd "/Users/name/My Documents"
   - cd "/Users/project/(session)/routes"
   - python "/path/with spaces/script.py"
   - rm "/tmp/file (copy).txt"
   - ls "/path/with[brackets]/file.txt"

   INCORRECT (will fail):
   - cd /Users/name/My Documents
   - cd /Users/project/(session)/routes
   - python /path/with spaces/script.py
   - rm /tmp/file (copy).txt
   - ls /path/with[brackets]/file.txt
`;

const POSIX_WORKING_DIR_BLOCK = `3. Working Directory Management:
   Prefer passing absolute paths to a tool over changing directories first:
   GOOD: <tool> /project/tests
   BAD: cd /project && <tool> tests
`;

const POSIX_TOOL_USAGE_SHELL_LINE = `- Avoid wrapping commands with 'bash -lc', 'zsh -lc', or 'sh -c'`;

const POSIX_PYTHON_PKG_BLOCK = `Python Package Management (CRITICAL):
Since each Execute runs in a NEW shell, you MUST chain all setup in one command!

WRONG (will fail):
- Execute: source venv/bin/activate
- Execute: pip install numpy  # FAILS - new shell doesn't have venv!

CORRECT approaches:
1. Direct venv usage (MOST RELIABLE):
   Execute: venv/bin/python -m pip install numpy
   Execute: .venv/bin/python script.py

2. Chain activation and command:
   Execute: source venv/bin/activate && pip install numpy
   Execute: source venv/bin/activate && python script.py

3. When pip is not found, try these IN ORDER:
   a) python3 -m pip install <package>
   b) python -m pip install <package>
   c) pip3 install <package>
   d) If "No module named pip": python3 -m ensurepip --default-pip && python3 -m pip install <package>

4. Check Python/pip availability:
   Execute: python3 --version && python3 -m pip --version
   Execute: which python3 || which python || echo "Python not found"

5. For conda environments:
   Execute: conda activate myenv && pip install <package>
   Execute: ~/miniconda3/envs/myenv/bin/python -m pip install <package>
`;

const POSIX_ENV_VARS_BLOCK = `Environment Variables & Virtual Environments:
- Environment variables do NOT persist between commands
- Virtual environment activations (venv, conda) must be done in each command
- Example: Instead of separate activation, use: "source venv/bin/activate && python script.py"
- Or directly use: "venv/bin/python script.py" (more reliable!)
`;

const POSIX_SECURITY_BLOCK = `Security:
- NEVER run destructive commands like 'rm -rf /' or 'rm -rf ~'
- NEVER delete, overwrite, move, or clean untracked files unless the user explicitly requested those exact files be removed.
- Treat cleanup commands that may remove untracked files, such as \`git clean\`, broad \`rm -rf\` globs, and \`find ... -delete\`, as HIGH risk.
- Be cautious with commands that modify system files
- Avoid running commands with sudo unless explicitly requested`;

const POSIX_EXIT_CODE_FIDELITY_BLOCK = `Exit-code fidelity:
A pipeline returns the exit code of the last command, so piping through \`tail\`/\`grep\` etc. can mask failures and make \`[Process exited with code 0]\` lie. When you need to trim noisy output, prefix with \`set -o pipefail\` so the pipeline inherits the first non-zero stage: \`set -o pipefail; <command> | tail -50\`.
`;

const POWERSHELL_PATH_QUOTING_BLOCK = `2. Path Quoting:
   Always quote file paths that contain spaces or special characters like '(', ')', '[', ']'. Use single quotes (PowerShell preserves the literal value):
   CORRECT:
   - Set-Location 'C:\\Users\\name\\My Documents'
   - python 'C:\\path\\with spaces\\script.py'
   - Remove-Item 'C:\\tmp\\file (copy).txt'
   - Get-ChildItem 'C:\\path\\with[brackets]\\file.txt' -LiteralPath

   INCORRECT (will fail):
   - Set-Location C:\\Users\\name\\My Documents
   - python C:\\path\\with spaces\\script.py
   - Remove-Item C:\\tmp\\file (copy).txt
`;

const POWERSHELL_WORKING_DIR_BLOCK = `3. Working Directory Management:
   Prefer passing absolute paths to a tool over changing directories first:
   GOOD: <tool> C:\\project\\tests
   BAD: Set-Location C:\\project; <tool> tests
`;

const POWERSHELL_TOOL_USAGE_SHELL_LINE = `- Avoid wrapping commands in nested 'powershell.exe -Command' or 'pwsh.exe -Command' invocations`;

function powershellPythonPkgBlock(legacy: boolean): string {
  const venvChain = legacy
    ? `2. Chain activation and command (PowerShell 5.1 — no && available):
   Execute: & 'venv\\Scripts\\Activate.ps1'; pip install numpy
   Execute: & 'venv\\Scripts\\Activate.ps1'; python script.py`
    : `2. Chain activation and command:
   Execute: & 'venv\\Scripts\\Activate.ps1' && pip install numpy
   Execute: & 'venv\\Scripts\\Activate.ps1' && python script.py`;

  const successCheck = legacy
    ? `   Execute: python --version; if ($LASTEXITCODE -eq 0) { python -m pip --version }`
    : `   Execute: python --version && python -m pip --version`;

  return `Python Package Management (CRITICAL):
Since each Execute runs in a NEW shell, you MUST chain all setup in one command!

WRONG (will fail):
- Execute: & 'venv\\Scripts\\Activate.ps1'
- Execute: pip install numpy  # FAILS - new shell doesn't have venv!

CORRECT approaches:
1. Direct venv usage (MOST RELIABLE):
   Execute: venv\\Scripts\\python.exe -m pip install numpy
   Execute: venv\\Scripts\\python.exe script.py

${venvChain}

3. When pip is not found, try these IN ORDER:
   a) python -m pip install <package>
   b) py -m pip install <package>      (Windows Python launcher; useful when 'python3' is the Microsoft Store stub)
   c) If you hit the Store stub error ("Python was not found; run without arguments..."), install with: winget install Python.Python.3

4. Check Python/pip availability:
${successCheck}
   Execute: Get-Command python, py, python3 -ErrorAction SilentlyContinue

5. For conda environments:
   Execute: conda activate myenv; pip install <package>
   Execute: $env:USERPROFILE\\miniconda3\\envs\\myenv\\python.exe -m pip install <package>
`;
}

const POWERSHELL_ENV_VARS_BLOCK = `Environment Variables & Virtual Environments:
- Environment variables do NOT persist between commands
- Set in current session: $env:VAR = "value"
- venv/conda activations don't persist across Execute calls — chain in one call or use direct paths to venv\\Scripts\\python.exe
`;

const POWERSHELL_SECURITY_BLOCK = `Security:
- NEVER run destructive commands like 'Remove-Item -Recurse -Force C:\\' or 'Remove-Item -Recurse -Force $HOME'
- NEVER delete, overwrite, move, or clean untracked files unless the user explicitly requested those exact files be removed.
- Treat cleanup commands that may remove untracked files, such as \`git clean\`, broad \`Remove-Item -Recurse -Force\` globs, and \`find ... -delete\`, as HIGH risk.
- Be cautious with commands that modify system files
- Avoid running commands with elevated privileges (Start-Process -Verb RunAs, runas) unless explicitly requested`;

const POWERSHELL_EXIT_CODE_FIDELITY_BLOCK = `Exit-code fidelity:
PowerShell pipelines reset \`$LASTEXITCODE\` to the rightmost cmdlet's exit, so piping through \`Select-Object\`/\`Out-String\` etc. can mask failures and make \`[Process exited with code 0]\` lie. Capture \`$LASTEXITCODE\` immediately after the upstream command, then re-exit with it: \`<command>; $rc = $LASTEXITCODE; ...; exit $rc\`.
`;

function powershellRuntimeGuidance(legacy: boolean): string {
  const chainHint = legacy
    ? `- Chain commands with ";" instead of "&&" (Windows PowerShell 5.1 does NOT support && or ||)
- For conditional fallback, use: if ($LASTEXITCODE -ne 0) { <fallback> }`
    : `- && and || work as pipeline-chain operators (PowerShell 7+); semicolons also work for unconditional sequencing`;

  return `
Shell: ${legacy ? 'Windows PowerShell 5.1 (legacy)' : 'PowerShell 7+ (pwsh)'}.
Commands execute in PowerShell, NOT Bash. You MUST use PowerShell syntax.

Command chaining:
${chainHint}

Common bash → PowerShell equivalents (this list is binding):
- Set environment variables: $env:VAR = "value"  (NOT export VAR=value)
- Remove directories: Remove-Item -Recurse -Force <path>  (NOT rm -rf)
- Search text: Select-String -Pattern "pattern" <file>  (NOT grep)
- View file start/end: Get-Content <file> -Head <N> / -Tail <N>  (NOT head / tail)
- List processes: Get-Process  (NOT ps aux / ps -ef)
- Find commands on PATH: Get-Command <name>  (NOT which)
- Null output sink: $null  (NOT /dev/null)
- HTTP requests: curl.exe <args>  (NOT bare 'curl', which is aliased to Invoke-WebRequest with different parameters)
- Source / dot-source scripts: . .\\script.ps1  (NOT 'source script.sh')
- Stream extraction: ForEach-Object / Select-Object / Where-Object  (NOT awk / sed in pipelines)
- Process trees / xargs: ForEach-Object (alias %)  (NOT xargs)
`;
}

const WSL_GUIDANCE_SECTION = `
WSL (Windows Subsystem for Linux) caveats:
You are in real bash inside a Linux VM running on a Windows host. POSIX syntax works natively.
But this Linux runs on a Windows host, which has consequences:
- /mnt/c bridges to the Windows filesystem and is SLOW (~10-50x slower than /home/) because it crosses the VM boundary via the 9P protocol. Prefer paths under /home/ for build artifacts, node_modules, virtualenvs, etc.
- Windows-edited scripts may have CRLF line endings. Symptoms: "$'\\r': command not found", "set: pipefail: invalid option name", or scripts that fail silently. Run 'dos2unix <file>' or check 'git config core.autocrlf'.
- Windows holds file locks differently than Linux. 'pip install' / 'npm install' retries on /mnt/c can hit "WinError 32: file in use" — switch to a /home/ working directory.
- Cross-OS interop: cmd.exe /c <cmd>, powershell.exe -Command <cmd>, wsl.exe (from the Windows side). Each spawns a separate Windows process with its own environment — env vars do NOT inherit across the boundary.
- Path translation: 'wslpath -w /home/foo' converts to a Windows path; 'wslpath -u "C:\\foo"' converts back to a Linux path.
`;

const CO_AUTHORED_COMMIT_STEP = `   - Create the commit with proper co-authorship:
     git commit -m "Your commit message

     Co-authored-by: industry-drool[bot] <138933559+industry-drool[bot]@users.noreply.github.com>"`;

const STANDARD_COMMIT_STEP =
  '   - Create the commit with an appropriate message';

interface RuntimeSubstitutions {
  pathQuoting: string;
  workingDir: string;
  toolUsageShellLine: string;
  pythonPkg: string;
  envVars: string;
  security: string;
  runtimeGuidance: string;
  exitCodeFidelity: string;
}

function posixSubstitutions(): RuntimeSubstitutions {
  return {
    pathQuoting: POSIX_PATH_QUOTING_BLOCK,
    workingDir: POSIX_WORKING_DIR_BLOCK,
    toolUsageShellLine: POSIX_TOOL_USAGE_SHELL_LINE,
    pythonPkg: POSIX_PYTHON_PKG_BLOCK,
    envVars: POSIX_ENV_VARS_BLOCK,
    security: POSIX_SECURITY_BLOCK,
    runtimeGuidance: '',
    exitCodeFidelity: POSIX_EXIT_CODE_FIDELITY_BLOCK,
  };
}

function wslSubstitutions(): RuntimeSubstitutions {
  return {
    ...posixSubstitutions(),
    runtimeGuidance: WSL_GUIDANCE_SECTION,
  };
}

function powershellSubstitutions(legacy: boolean): RuntimeSubstitutions {
  return {
    pathQuoting: POWERSHELL_PATH_QUOTING_BLOCK,
    workingDir: POWERSHELL_WORKING_DIR_BLOCK,
    toolUsageShellLine: POWERSHELL_TOOL_USAGE_SHELL_LINE,
    pythonPkg: powershellPythonPkgBlock(legacy),
    envVars: POWERSHELL_ENV_VARS_BLOCK,
    security: POWERSHELL_SECURITY_BLOCK,
    runtimeGuidance: powershellRuntimeGuidance(legacy),
    exitCodeFidelity: POWERSHELL_EXIT_CODE_FIDELITY_BLOCK,
  };
}

function substitutionsFor(
  runtimeShell: ExecuteCliRuntimeShell
): RuntimeSubstitutions {
  switch (runtimeShell) {
    case ExecuteCliRuntimeShell.PowerShell5:
      return powershellSubstitutions(/* legacy */ true);
    case ExecuteCliRuntimeShell.PowerShell7:
      return powershellSubstitutions(/* legacy */ false);
    case ExecuteCliRuntimeShell.WslBash:
      return wslSubstitutions();
    case ExecuteCliRuntimeShell.Posix:
    case ExecuteCliRuntimeShell.Unknown:
    default:
      return posixSubstitutions();
  }
}

/**
 * Substitute a single placeholder.
 *
 * IMPORTANT: we use a function replacer rather than passing the substitution
 * string directly. `String.prototype.replace(string, string)` interprets the
 * tokens `$$`, `$&`, `` $` ``, `$'`, and `$<name>` in the replacement string
 * as substitution patterns. Several substitution blocks (notably the WSL
 * guidance text "$'\\r': command not found" and the PowerShell exit-code
 * guidance "$LASTEXITCODE") legitimately contain these tokens. Using the
 * raw string form would cause $' to expand to the post-match portion of
 * the template, splicing unrelated content into the middle of the output
 * and corrupting the prompt. The function form is treated literally.
 *
 * See FAC-19754 review and the `template-substitution-invariants` describe
 * block in executeCli.test.ts for regression coverage.
 */
function substitutePlaceholder(
  template: string,
  placeholder: string,
  value: string
): string {
  return template.replace(placeholder, () => value);
}

export function getExecuteCliDescription({
  includeCoAuthoredByDrool,
  runtimeShell = ExecuteCliRuntimeShell.Unknown,
}: {
  includeCoAuthoredByDrool: boolean;
  runtimeShell?: ExecuteCliRuntimeShell;
}): string {
  const commitStep = includeCoAuthoredByDrool
    ? CO_AUTHORED_COMMIT_STEP
    : STANDARD_COMMIT_STEP;
  const subs = substitutionsFor(runtimeShell);

  let result = TEMPLATE;
  result = substitutePlaceholder(result, COMMIT_STEP_PLACEHOLDER, commitStep);
  result = substitutePlaceholder(
    result,
    PATH_QUOTING_PLACEHOLDER,
    subs.pathQuoting
  );
  result = substitutePlaceholder(
    result,
    WORKING_DIR_PLACEHOLDER,
    subs.workingDir
  );
  result = substitutePlaceholder(
    result,
    TOOL_USAGE_SHELL_LINE_PLACEHOLDER,
    subs.toolUsageShellLine
  );
  result = substitutePlaceholder(
    result,
    PYTHON_PKG_PLACEHOLDER,
    subs.pythonPkg
  );
  result = substitutePlaceholder(result, ENV_VARS_PLACEHOLDER, subs.envVars);
  result = substitutePlaceholder(result, SECURITY_PLACEHOLDER, subs.security);
  result = substitutePlaceholder(
    result,
    RUNTIME_GUIDANCE_PLACEHOLDER,
    subs.runtimeGuidance
  );
  result = substitutePlaceholder(
    result,
    EXIT_CODE_FIDELITY_PLACEHOLDER,
    subs.exitCodeFidelity
  );
  return result;
}

const BASH_DESCRIPTION = getExecuteCliDescription({
  includeCoAuthoredByDrool: true,
});

export const executeCliTool = createTool({
  id: EXECUTE_CLI_TOOL_ID,
  llmId: TOOL_LLM_ID_EXECUTE,
  uiGroupId: ToolUIGroupId.ExecuteTerminalCommand,
  displayName: 'Execute',
  description: BASH_DESCRIPTION,
  executionLocation: ToolExecutionLocation.Client,
  inputSchema: executeCliWithBackgroundSchema,
  outputSchemas: {
    result: z.string().describe('The output of the command'),
  },
  isVisibleToUser: false,
  isTopLevelTool: true,
  requiresConfirmation: false,
  sideEffects: [SandboxSideEffect.Process],
  toolkit: Toolkit.Base,
  isToolEnabled: true,
});
