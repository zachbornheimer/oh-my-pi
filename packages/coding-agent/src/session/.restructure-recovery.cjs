const fs = require('fs');
const ts = require('typescript');
const dir = __dirname;
const source = fs.readFileSync(`${dir}/turn-recovery.ts`, 'utf8');
const ast = ts.createSourceFile('turn-recovery.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const klass = ast.statements.find(s => ts.isClassDeclaration(s) && s.name.text === 'TurnRecovery');
const members = new Map(klass.members.filter(m => m.name).map(m => [m.name.getText(ast).replace(/^#/, ''), m]));
const groups = {
 attribution: ['fallbackRoutedFor','lastServed','demotedReasoningOmittedFor','bootstrapCache','fallbackRouted','markFallbackRouted','servingModel','reanchorServedAttribution','omitsDemotedReasoning'],
 saga: ['retryAbortController','retryAttempt','genericAbortStreak','refusalWalkTried','accountPolicyRotationsRemaining','retryPromise','retryResolve','midStreamRefusalResampled','attempt','resolveRetry','closeRetrySaga','endCancelledRetry','failRetryAfterLocalContinueError','abortRetry','isRetrying','autoRetryEnabled','setAutoRetryEnabled'],
 errors: ['pendingRetryErrors','clearPendingRetryErrors','persistTerminalEmptyErrorTurn','retryRecoveryKind','retryRecoveryNote','recordPendingRetryError','markPendingRetryErrors'],
 history: ['dropPersistedAssistantTurn','dropAssistantTurnDurably','runRecoveryCompactionWithRollback','restoreFailedAssistantTurn','discardAcceptedTerminalEmptyStop','cutBranchBefore','discardAssistantTurn','stripForToolReplay'],
 context: ['removeAssistantMessageFromActiveContext','stripFailedAssistantTail','promptAgentWithIdleRetry','hasAbortedToolCallTail','retry','prepareResume'],
 eligibility: ['classifyRetryMessage','isUsagePreflightBlocked','isRetryableReasonlessAbort','isRetryableError','unexecutedToolCallsReplaySafe','classifyResolvedInterruptedToolTurn','isMidStreamTransportFailure','hasReplayUnsafeOutput','isBoundedThinkingStreamClose','isFirstAttemptMidStreamSocketDrop','isClassifierRefusal','activeFireworksFastModel','isFireworksFastFallbackEligible','isHardErrorFallbackEligible','overflowTextContradictedByFit','isRecoverableProviderEmptyOutput'],
 terminal: ['emptyStopRetryCount','acceptTerminalEmptyStopForPrompt','setAcceptTerminalEmptyStop','handleEmptyAssistantStop','emptyStopRetryReminder'],
 stop: ['unexpectedStopJudgeTimeoutMs','unexpectedStopRetryCount','handleUnexpectedAssistantStop','latestOperatorRequest','unexpectedStopRetryReminder'],
 reminders: ['malformedFunctionCallRetryCount','streamStallContinueCount','handleMalformedFunctionCallStop','handleCommittedTextStreamStall','maybeInjectThinkingLoopRedirect','maybeInjectMalformedFunctionCallRedirect'],
 chains: ['fallbackChainWarnings','pendingDiscoveryDeferredValidation','fallbackChainsValidated','getRetryFallbackResolutionContext','getRetryFallbackChains','validateRetryFallbackChains','hasPendingDiscoveryDeferredFallbackValidation','revalidateRetryFallbackChainsAfterDiscovery','getRetryFallbackRevertPolicy','isRetryFallbackSelectorSuppressed','noteRetryFallbackCooldown','resolveRetryFallbackRole','retryFallbackChainKeys','liveRetryRoleHint','findRetryFallbackCandidates','refusalWalkKey'],
 candidates: ['nextSideRequestFallback','tryRetryModelFallback','isNoOpRetryFallback'],
 selection: ['activeRetryFallback','activeFallbackCreditRedemption','clearActiveRetryFallback','consumeActiveFallbackCreditRedemption','applyRetryFallbackCandidate','tryFireworksFastFallback','maybeRestoreRetryFallbackPrimary'],
 usage: ['usageReserveApproval','maybeApplyUsageAwareFallback','applyMissingCredentialFallback','findKeyedRetryFallback','confirmUsageFallback'],
 credentials: ['usageLimitOutcomes','recordUsageLimitOutcome','parseRetryAfterMsFromError'],
 attempt: ['requestBodyReadTimeoutRecoveryPromptSequence','handleResponsesRequestBodyReadTimeout','handleRetryableError','applyRetryPolicy','onAssistantSettledSuccessfully','onErrorSettledWithoutRetry','resetForNewPrompt'],
};
// Public forwarding methods were historically duplicated with their private implementation.
const forwarding = new Set(['persistTerminalEmptyErrorTurn','handleEmptyAssistantStop','handleUnexpectedAssistantStop','dropPersistedAssistantTurn','runRecoveryCompactionWithRollback','maybeRestoreRetryFallbackPrimary','maybeApplyUsageAwareFallback','handleRetryableError','promptAgentWithIdleRetry','parseRetryAfterMsFromError']);
for (const m of klass.members) {
 if (!m.name) continue;
 const name=m.name.getText(ast);
 if (name.startsWith('#')) members.set(name.slice(1),m);
}
const owner = new Map();
for(const [group,names] of Object.entries(groups)) for(const name of names) owner.set(name,group);
const className = g => 'Recovery'+g[0].toUpperCase()+g.slice(1);
const rootPrefix = source.slice(0,klass.getFullStart());
// Pure tail decisions have no session capability.
const replayStart=source.indexOf('function hasNonWhitespace');
const replayEnd=source.indexOf('/** Result shape shared');
const replaySource=source.slice(replayStart,replayEnd).replace(/^function /gm,'export function ');
const sameMember=members.get('isSameAssistantMessage');
const sameSource=sameMember.getText(ast).replace('#isSameAssistantMessage(', 'export function isSameAssistantMessage(');
const imports=ast.statements.filter(ts.isImportDeclaration).map(n=>n.getText(ast)).join('\n');
fs.writeFileSync(`${dir}/recovery-replay.ts`,imports+'\n'+replaySource+'\n'+sameSource+'\n');
const replayNames=['hasNonWhitespace','conversationEnd','syntheticToolResultTailStart','retryableAssistantTurnEnd','isCutOffAssistant','unansweredPrompt','abortedToolCallTail','toolReplayStart','isSameAssistantMessage'];
const declarations=source.slice(source.indexOf('const THINKING_LOOP_REDIRECT_TYPE'),replayStart)+source.slice(replayEnd,klass.getFullStart());
fs.writeFileSync(`${dir}/recovery-contracts.ts`,imports+'\n'+declarations.replace(/^(const|type) /gm,'export $1 '));
const contractNames=[...declarations.matchAll(/^(?:export )?(?:const|type|interface) (\w+)/gm)].map(m=>m[1]);
function transform(text,group){
 text=text.replace(/this\.#isSameAssistantMessage/g,'isSameAssistantMessage');
 text=text.replace(/this\.#(\w+)/g,(all,name)=>{
  if(name==='host') return all;
  const target=owner.get(name);
  if(!target) throw Error('No owner '+name+' in '+group);
  return target===group ? 'this.'+name : 'this.#owners.'+target+'.'+name;
 });
 text=text.replace(/^\s*readonly #host: TurnRecoveryHost;\n/gm,'');
 return text;
}
const groupTexts={};
for(const [g,names] of Object.entries(groups)){
 let body=names.map(name=>{
  const member=members.get(name);
  if(!member) throw Error('missing '+name);
  let text=member.getText(ast).replace(/^(readonly )?#/, '$1');
  if(g==='stop'&&name==='unexpectedStopJudgeTimeoutMs') text='readonly unexpectedStopJudgeTimeoutMs: number;';
  return transform(text,g);
 }).join('\n\n');
 const hosts=[...new Set([...body.matchAll(/this\.#host\.(\w+)/g)].map(m=>m[1]))];
 const deps=[...new Set([...body.matchAll(/this\.#owners\.(\w+)/g)].map(m=>m[1]))];
 const port=`export type ${className(g)}Port = Pick<TurnRecoveryHost, ${hosts.map(x=>JSON.stringify(x)).join(' | ') || 'never'}>;`;
 const ownertype=deps.map(x=>`${x}: ${className(x)}`).join('; ');
 let init='';
 if(g==='stop') init='this.unexpectedStopJudgeTimeoutMs = options.unexpectedStopJudgeTimeoutMs ?? UNEXPECTED_STOP_TIMEOUT_MS;';
 if(g==='selection') init=`if(options.initialRetryFallback) { this.activeRetryFallback = {...options.initialRetryFallback, lastAppliedFallbackThinkingLevel: host.configuredThinkingLevel(), pinned: options.initialRetryFallback.pinned ?? false}; this.#owners.attribution.markFallbackRouted(); }`;
 const output=imports+'\n'+`import { ${replayNames.join(', ')} } from './recovery-replay';\nimport { ${contractNames.join(', ')} } from './recovery-contracts';\n`+deps.map(d=>`import type { ${className(d)} } from './recovery-${d}';`).join('\n')+`\n${port}\n\n/** ${g} owns only its declared recovery capability. */\nexport class ${className(g)} {\nreadonly #host: ${className(g)}Port;\nreadonly #owners: { ${ownertype} };\nconstructor(host: ${className(g)}Port, owners: { ${ownertype} }, options: TurnRecoveryOptions = {}) { this.#host=host; this.#owners=owners; ${init} }\n${body}\n}\n`;
 groupTexts[g]=output;
 fs.writeFileSync(`${dir}/recovery-${g}.ts`,output);
}
const publics=klass.members.filter(m=>m.name&&!m.name.getText(ast).startsWith('#')&&!ts.isConstructorDeclaration(m));
let root=imports+'\n'+`import type { TurnRecoveryHost, TurnRecoveryOptions } from './recovery-contracts';\nexport type { TurnRecoveryHost, TurnRecoveryOptions, RecoveryCompactionResult } from './recovery-contracts';\nexport { kUsageLimitRequestProvider } from './recovery-contracts';\n`+Object.keys(groups).map(g=>`import { ${className(g)} } from './recovery-${g}';`).join('\n');
root+='\n/** Composes recovery owners; execution receives only consumer-specific capabilities. */\nexport class TurnRecovery {\n'+Object.keys(groups).map(g=>`readonly #${g}: ${className(g)};`).join('\n')+'\nconstructor(host: TurnRecoveryHost, options: TurnRecoveryOptions = {}) {\nconst root=this;\n';
// Constructors do not consume cyclic dependencies until all owners have been composed, except selection attribution.
const order=Object.keys(groups);
for(const g of order){
 const deps=[...new Set([...groupTexts[g].matchAll(/this\.#owners\.(\w+)/g)].map(m=>m[1]))];
 root+=`this.#${g}=new ${className(g)}(host,{${deps.map(d=>`get ${d}(){return root.#${d};}`).join(',')}},options);\n`;
}
root+='if(!options.deferFallbackChainValidation) this.#chains.validateRetryFallbackChains();\n}\n';
for(const member of publics){
 const name=member.name.getText(ast);
 const g=owner.get(name);
 if(!g) throw Error('public owner missing '+name);
 if(ts.isGetAccessor(member)) { root+=`get ${name}(): ${member.type.getText(ast)} { return this.#${g}.${name}; }\n`; continue; }
 const signature=member.getText(ast).slice(0,member.body.pos-member.getStart(ast));
 const args=member.parameters.map(p=>p.name.getText(ast)).join(',');
 root+=signature+`{ return this.#${g}.${name}(${args}); }\n`;
}
root+='}\n';
fs.writeFileSync(`${dir}/turn-recovery.ts`,root);
console.log('Created recovery owners');
