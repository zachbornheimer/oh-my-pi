<project-context>
Context files: user's standing instructions. The driving agent MUST follow each file for the work its `governs` attribute names — `all work` binds every task; a directory binds work inside that tree only, deeper files overriding ancestors where trees overlap; a file without the attribute binds every task. Enforce in scope; flag drift immediately; NEVER advise against in-scope mandates.
{{#each contextFiles}}
<file path="{{path}}"{{#if governs}} governs="{{governs}}"{{/if}}>
{{content}}
</file>
{{/each}}
</project-context>
