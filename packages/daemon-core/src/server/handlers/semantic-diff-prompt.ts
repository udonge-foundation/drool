export function generateSemanticDiffPrompt(
  baseBranch: string,
  currentBranch: string
): string {
  return `You are a technical writer creating a semantic diff summary for display in a web UI panel.

Your task is to analyze the git diff provided below (comparing branch \`${currentBranch}\` against \`${baseBranch}\`) and produce a well-structured markdown document that helps developers understand what was changed and how it all works together.

The complete git diff is provided in a <git_diff> tag at the end of this prompt. Analyze ALL changes in that diff thoroughly.

## Step 1: Analyze and Group Changes

Analyze the provided diff output and group related changes together semantically. Consider grouping by:
- Feature area (e.g., "Authentication", "UI Components", "Data Layer")
- Type of change (e.g., "Bug Fixes", "New Features", "Refactoring")
- Module or service affected

Do NOT organize by file - instead, group files that work together for the same purpose.

## Step 2: Generate the Semantic Diff

Create a markdown document with the following structure:

### Required Sections

1. **Title and Overview**
   - Start with a descriptive title: \`# [Brief Descriptive Title]\`
   - Add a subtitle showing the branch comparison: \`Comparing \`${currentBranch}\` → \`${baseBranch}\`\`
   - Write a detailed overview paragraph (4-6 sentences) explaining:
     - The main purpose/goal of these changes
     - The key components or systems that were added/modified
     - The overall approach taken
     - Any important architectural decisions

2. **Diagram** (Encouraged when helpful)
   If the changes involve meaningful flow or structure, include a Mermaid diagram. Choose the type that best illustrates the changes:
   
   - **Architecture diagram**: Show components, services, and their relationships
   - **Data flow diagram**: Show how data moves through the system
   - **Happy path / sequence**: Show the steps in a user flow or process
   - **State diagram**: Show state transitions if relevant
   
   Use Mermaid syntax in a code block. Guidelines for better diagrams:
   - Use descriptive node labels (not abbreviated) - e.g. \`A[User Authentication]\` not \`A[Auth]\`
   - Use subgraphs to group related components: \`subgraph Frontend\`
   - Prefer \`graph TD\` (top-down) for vertical layouts that fit in side panels
   - Keep diagrams focused: 5-12 nodes max for readability
   - Use different node shapes to differentiate types: \`[rectangles]\` for components, \`(rounded)\` for actions, \`{diamonds}\` for decisions
   
   \`\`\`mermaid
   graph TD
       subgraph Frontend
           A[User Interface] --> B[Session Controller]
       end
       subgraph Backend
           C[API Handler] --> D[Database Service]
       end
       B --> C
   \`\`\`
   
   Or for sequence diagrams:
   \`\`\`mermaid
   sequenceDiagram
       participant User
       participant Frontend
       participant Backend
       User->>Frontend: Action
       Frontend->>Backend: Request
       Backend-->>Frontend: Response
   \`\`\`
   
   Skip the diagram if the changes are simple refactors or don't have meaningful flow to visualize.

3. **Table of Contents**
   A bullet list summarizing each section with title and a brief description (~10 words):
   \`\`\`markdown
   ## Contents
   - **Section 1: User Authentication** - JWT validation, session management, and login flow
   - **Section 2: Database Layer** - New migrations and model updates for user data
   - **How It Fits Together** - System integration overview
   \`\`\`

4. **Semantic Sections** (one per logical group of changes)
   Create as many sections as needed to cover the changes thoroughly. For a large diff, expect 5-10+ sections.
   
   Each section should tell a story by **interleaving explanation and code**. Don't dump all code at the end - weave it into the narrative:
   
   - **Section Title**: Descriptive name (e.g., "## Section 1: User Authentication Flow")
   - **Files**: List of ALL affected files in this section with backticks
   - **Narrative with Code**: Tell the story of the changes by alternating between:
     - Explanation paragraphs describing what's happening and why
     - Code blocks showing the relevant diff (with inline \`// <--\` comments)
     - More explanation connecting to the next piece of code
     
     **CRITICAL: Diff block format** - Every diff block MUST start with a file header and line numbers:
     \`\`\`diff
     --- a/path/to/file.ts
     +++ b/path/to/file.ts
     @@ -startLine,count +startLine,count @@
     +added line
     -removed line
      context line
     \`\`\`
     
     Example with proper headers:
     > "The service validates input parameters in the handler..."
     > \`\`\`diff
     > --- a/src/services/UserService.ts
     > +++ b/src/services/UserService.ts
     > @@ -45,8 +45,12 @@ export class UserService {
     > +  private validateInput(input: UserInput): boolean {
     > +    if (!input.email) {  // <-- Required field check
     > +      throw new ValidationError('Email required');
     > +    }
     > +    return true;
     > +  }
     > \`\`\`
   
   - Include 20-50 lines of diff per section total (more for complex changes)
   - Include function signatures, type definitions, and key logic
   - Always use the actual file paths from the git diff
   - Always include @@ line numbers showing where in the file the changes are
   - **Impact & Risks**: Note any significant impacts or risks with inline risk level. Format each as:
     \`**[Category]** *[Risk Level]*: [Description]\`
     
     Categories can include (but aren't limited to):
     - Security, Auth, Filesystem, Network, Database, Config, Performance, Breaking Change, etc.
     
     Risk levels (always include one):
     - *Low risk* - Minor impact, easily reversible
     - *Medium risk* - Moderate impact, may need attention
     - *High risk* - Significant impact, needs careful review
     
     Examples:
     - **Filesystem** *Low risk*: Writes to user data directory ~/.industry/sessions/
     - **Security** *High risk*: API keys now read from environment variables
     - **Breaking Change** *Medium risk*: Function signature changed, callers need updates

5. **How It Fits Together** (REQUIRED - Always include this section)
   Write 1-2 concise paragraphs that:
   - Reference the sections above by name (e.g., "The UserService from Section 1 coordinates with...")
   - Follow the story arc: trigger → processing → output
   - Connect the dots between components without repeating section details
   
   Keep it tight - readers have already seen the details. Focus on the "aha" moment of how it all connects.

## Important Guidelines

1. **Be Thorough**: Cover ALL significant changes - don't skip files or features. A 4000-line diff should produce a substantial semantic diff.
2. **Be Selective**: Show the most meaningful code, not every line - but include enough context to understand the changes.
3. **Explain the Why**: Use inline comments to explain non-obvious decisions.
4. **Highlight Risks**: Always note security, filesystem, or network implications.
5. **Tell a Story**: The "How It Fits Together" section should read like documentation.
6. **Use Proper Markdown**: Ensure all formatting is valid markdown.
7. **Mermaid Diagrams**: Use Mermaid syntax for all diagrams (not ASCII art).

## Output

Generate the semantic diff markdown now. The output should be comprehensive and detailed - aim for thorough coverage of all changes. The output should be the complete markdown content, ready to display in the web UI.`;
}
