export const UI_CONSOLE_PAPER_CSS = String.raw`
/* Hallmark v2 · theme: console (by request) · console: paper · scope: app */
/* Critique: a working record, with measured time prominent and controls kept close to their context. */
:root{background:var(--paper);--paper:oklch(98% .006 85);--paper-2:oklch(99.5% .003 85);--paper-3:oklch(95.5% .009 85);--ink:oklch(19% .01 60);--ink-2:oklch(33% .012 60);--muted:oklch(44% .012 60);--line:oklch(85% .012 80);--line-strong:oklch(60% .018 80);--amber:oklch(54% .14 70);--amber-text:oklch(44% .12 70);--amber-ink:oklch(99% .003 85);--amber-soft:oklch(94% .035 80);--blue:oklch(46% .12 250);--blue-soft:oklch(94% .025 250);--red:oklch(44% .14 25);--red-soft:oklch(95% .025 25);--green:var(--amber);--panel:var(--paper-2);--font-body:'Host Grotesk',system-ui,sans-serif;--font-measured:'Atkinson Hyperlegible Mono',ui-monospace,monospace;--overlay:oklch(19% .01 60 / .48)}
html,body{overflow-x:clip;background:var(--paper)}body{background:var(--paper);color:var(--ink);font-family:var(--font-body);line-height:1.5}.shell{max-width:1200px;padding:32px 28px 80px}.top{align-items:end;margin-bottom:24px;padding-bottom:22px;border-bottom:1px solid var(--line-strong)}h1,h2,h3,h4{color:var(--ink);font-weight:500;letter-spacing:-.025em;min-width:0;overflow-wrap:break-word}h1{font-size:clamp(2rem,4vw,3rem);line-height:1.05;margin:0}h2{font-size:1.2rem;margin:0 0 16px}h3{font-size:1.05rem}p{line-height:1.55}.muted{color:var(--muted)}#who{font-size:.875rem;text-align:right}.nav{gap:0;margin-bottom:28px;padding:0;border-bottom:1px solid var(--line-strong)}.nav button{border:0;padding:12px 18px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent}.nav button:hover:not([aria-current=page]):not(:disabled){border-color:transparent}.nav button[aria-current=page]{color:var(--ink);border-color:var(--amber)}
button,input,textarea,select{font-family:var(--font-body)}button{background:var(--paper-2);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;font-weight:500;padding:.65rem .9rem;min-height:42px;transition:background-color .15s ease,border-color .15s ease}button:hover:not(:disabled){background:var(--paper-3);border-color:var(--amber)}button:active:not(:disabled){background:var(--amber-soft)}button.primary,.primary{background:var(--amber);border-color:var(--amber);color:var(--amber-ink)}button.primary:hover:not(:disabled){background:var(--ink-2);border-color:var(--ink-2);color:var(--paper-2)}button.primary:active:not(:disabled){background:var(--ink);border-color:var(--ink)}button.danger{color:var(--red);background:var(--paper-2);border-color:var(--line-strong)}button.danger:hover:not(:disabled){background:var(--red-soft);border-color:var(--red)}button.danger:active:not(:disabled){background:var(--red);color:var(--paper-2);border-color:var(--red)}:is(button,a,input,textarea,select,summary,[role=button]):focus-visible{outline:3px solid var(--amber);outline-offset:2px}a{color:var(--ink-2);text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{color:var(--amber)}
.grid{grid-template-columns:minmax(0,1.3fr) minmax(0,.7fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:20px}.grid>.panel{border:0;border-radius:0;margin:0}.panel{background:var(--paper-2);border:1px solid var(--line);border-radius:10px;box-shadow:none;padding:24px;margin-bottom:20px}.current{min-height:240px}.metrics{gap:1px;background:var(--paper-3);border:1px solid var(--line);border-radius:6px;overflow:hidden}#view-overview .grid .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric{background:var(--paper-3);border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0;padding:14px}.metric small{font-size:.8rem;color:var(--muted);margin-bottom:10px}.metric strong{font-family:var(--font-measured);font-size:1.15rem;font-weight:400;color:var(--blue);font-variant-numeric:tabular-nums}.timer,#active>.active-plan .timer{font-family:var(--font-measured);font-size:clamp(2rem,4vw,3rem);font-weight:400;letter-spacing:-.04em;line-height:1.1;color:var(--blue);font-variant-numeric:tabular-nums;margin:15px 0}.active-plan .timer{color:var(--blue)}#active{gap:0}#active>.active-plan{border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0;margin:0;color:var(--ink)}#active>.active-plan:first-child{border-top:0;padding-top:0}#active>.active-plan:last-child{padding-bottom:0}.active-plan .plan-open{font-size:1.08rem;font-weight:500}.plan-open{background:transparent;border:0;min-height:0}.plan-open:hover:not(:disabled){background:transparent;color:var(--amber)}
.list{gap:0}.row,.analytics-plan{background:var(--paper-2);border:0;border-bottom:1px solid var(--line);border-radius:0;padding:16px 0}.row:first-child,.analytics-plan:first-child{border-top:1px solid var(--line)}.row-title{font-weight:500}.row-meta,.analytics-plan-meta{color:var(--muted);line-height:1.45}.row-right{gap:8px}.badge{border:1px solid var(--line);border-radius:4px;background:var(--blue-soft);color:var(--blue);font-size:.78rem;font-weight:500;padding:.25rem .5rem}.badge.paused{background:var(--amber-soft);color:var(--amber-text)}.badge.completed{background:var(--paper-3);color:var(--muted)}.pager-arrow{background:var(--paper-2);color:var(--ink);border-color:var(--line-strong)}.pager-page{font-family:var(--font-measured)}
.checkbox-field{display:flex;align-items:flex-start;gap:8px;min-height:44px;cursor:pointer}.checkbox-field input{flex:0 0 16px;width:16px;height:16px;min-height:0;margin:4px 0 0;padding:0}.checkbox-field>span{min-width:0}.field label{font-size:.875rem;font-weight:500;color:var(--ink-2)}.field input,.field textarea,.field select,.form>input,.form>textarea,.tracker-form input,.tracker-form textarea,.tracker-form select{background:var(--paper-3);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;padding:.65rem}.field textarea{min-height:90px}input::placeholder,textarea::placeholder{color:var(--muted);opacity:1}.notice{color:var(--ink-2);background:var(--amber-soft);border-color:var(--line-strong);border-radius:6px}.error,.form-error{color:var(--red);background:var(--red-soft);border-color:var(--red);border-radius:6px}.form-error:empty{display:none}.bar{background:var(--paper-3);border-radius:2px}.bar span,.step-bar{background:var(--blue)}.step-column{border:0;min-height:0}.step-column:hover:not(:disabled){background:transparent;border:0}.step-column:hover .step-bar,.step-column:focus .step-bar{background:var(--ink-2)}.barrow>span,.step-y-axis,.step-x-label{font-variant-numeric:tabular-nums}.step-tooltip{background:var(--ink);color:var(--paper-2);border-radius:6px;box-shadow:none}.step-tooltip span{color:var(--paper)}.analytics-plan{padding:0}.analytics-plan>summary.row,.analytics-plan>summary.row:first-child{border:0;border-radius:0;padding:16px 0}.step-chart-body{margin:0;padding:16px 0}.modal{background:var(--overlay)}.modalbox{background:var(--paper-2);border:1px solid var(--line-strong);border-radius:10px;box-shadow:none;padding:24px}.toast{background:var(--ink);color:var(--paper-2);border-radius:6px}.toast.error{background:var(--red);color:var(--paper-2)}
.tracker-section{border-color:var(--line)}.tracker-list{gap:0}.tracker-card{background:var(--paper-2);border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0}.tracker-card:last-child{border-bottom:1px solid var(--line)}.tracker-card-toggle{min-height:42px}.tracker-card-toggle:hover:not(:disabled){background:transparent;color:var(--amber)}.tracker-meta,.tracker-card-status{color:var(--muted)}.tracker-marker{border-radius:4px;background:var(--paper-3);font-weight:500}.tracker-marker.GAP,.tracker-marker.LATE,.tracker-marker.STALE_EXECUTOR{background:var(--amber-soft);color:var(--amber-text)}.tracker-marker.CORRECTION{background:var(--blue-soft);color:var(--blue)}
.period-filter,.period-filter .toolbar,.period-filter .metrics,.period-filter .metric{min-width:0;max-width:100%}.period-filter .metric{overflow-wrap:anywhere}.period-filter .toolbar>button{min-width:0;max-width:100%;overflow-wrap:anywhere}
@media(max-width:720px){.shell{padding:24px 16px 60px}.grid{grid-template-columns:minmax(0,1fr)}.panel{padding:18px}.top{align-items:start}#who{text-align:left}}@media(max-width:600px){.tracker-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}.tracker-card-toggle>strong{grid-column:1;grid-row:1}.tracker-card-toggle>.tracker-card-status{grid-column:1;grid-row:2}.tracker-card-toggle>span:last-child{grid-column:2;grid-row:1}.nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));overflow:visible}.nav button{padding:12px;text-align:center}.tracker-card{padding:14px 0}.modalbox{padding:18px}.metrics,#view-overview .grid .metrics{grid-template-columns:1fr}.row{padding:14px 0}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0s!important;animation-duration:0s!important;animation-iteration-count:1!important}}
/* Hallmark · component: training history · genre: modern-minimal · theme: Console Paper · v2.0.0 */
/* Critique: the result leads each row, while timestamps and calculation details remain easy to compare. */
.atlm-attempts .atlm-history{min-width:610px;line-height:1.4}
.atlm-attempts .atlm-history th,.atlm-attempts .atlm-history td{padding:12px}
.atlm-history th{background:var(--paper-3);color:var(--ink-2);font-weight:500;white-space:nowrap}
.atlm-history tbody tr:nth-child(even){background:var(--paper)}
.atlm-history .atlm-attempt-date,.atlm-history .atlm-attempt-count{font-variant-numeric:tabular-nums}
.atlm-history time{white-space:nowrap;font-weight:500}
.atlm-history .atlm-attempt-count,.atlm-history th:nth-child(3){text-align:right}
.atlm-attempt-duration{display:block;margin-top:4px;color:var(--muted);font-size:.8rem}
.atlm-attempt-outcome{display:block;font-weight:600}
.atlm-history tr[data-outcome="success"] .atlm-attempt-outcome{color:var(--blue)}
.atlm-history tr[data-outcome="error"] .atlm-attempt-outcome{color:var(--red)}
.atlm-history tr[data-outcome="pending"] .atlm-attempt-outcome{color:var(--amber-text)}
.atlm-attempt-reason{color:var(--ink-2)}
.atlm-attempt-details{margin-top:4px}
.atlm-attempt-details summary{width:fit-content;color:var(--ink-2);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}
.atlm-attempt-details summary:hover,.atlm-attempt-details summary:active{color:var(--ink);text-decoration-color:var(--amber)}
.atlm-attempt-details dl{margin:8px 0 0;display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:4px 12px;font-size:.83rem}
.atlm-attempt-details dd{margin:0;color:var(--muted)}
.atlm-attempts .atlm-cell-label{display:none}
.atlm-history-wrap+button{margin-top:12px}
@media(max-width:720px){
  .atlm-attempts .atlm-history-wrap{overflow:visible}
  .atlm-attempts .atlm-history,.atlm-history tbody{display:block;min-width:0}
  .atlm-history thead{position:absolute;width:1px;height:1px;overflow:clip;clip-path:inset(50%);white-space:nowrap}
  .atlm-history tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;padding:12px;border-top:1px solid var(--line)}
  .atlm-history tbody tr:last-child{border-bottom:1px solid var(--line)}
  .atlm-attempts .atlm-history td{display:block;min-width:0;padding:0;border:0;text-align:left}
  .atlm-history .atlm-attempt-reason{grid-column:1/-1}
  .atlm-history time{white-space:normal}
  .atlm-attempts .atlm-cell-label{display:block;margin-bottom:4px;color:var(--muted);font-size:.8rem}
}

`;

export const UI_TYPOGRAPHY_CSS = String.raw`
/* Hallmark v2 · theme: console · console: paper · scope: app · redesign: polish */
/* Critique: the plan is the reading surface; headings have distinct sizes and technical evidence is absent from the UI. */
/* Hallmark · finish-review: subagent · 2 findings · 2 resolved · gap: none */
/* Hallmark · dropped #criteria · the user requested the original plan as one document. */
:root{--text-xs:.75rem;--text-sm:.875rem;--text-md:1rem;--text-lg:1.2rem;--text-xl:1.44rem;--text-2xl:1.728rem;--text-3xl:2.074rem}
html,body{overflow-x:clip}body{font-size:var(--text-md)}
h1,h2,h3,h4,h5,h6{font-family:var(--font-body);font-weight:500;color:var(--ink);letter-spacing:normal;line-height:1.3;min-width:0;overflow-wrap:anywhere;text-wrap:balance}
h1{font-size:var(--text-3xl)}h2{font-size:var(--text-2xl)}h3{font-size:var(--text-xl)}h4,h5,h6{font-size:var(--text-lg)}
button,input,textarea,select{font-size:var(--text-md);line-height:1.5}input:not([type=checkbox]):not([type=radio]),select{min-height:44px}button{min-height:44px}
:is(.field>label,label.field,.tracker-meta,.row-meta,.analytics-plan-meta,.tracker-card-status,.tracker-timeline time,.pager,.step-method,.step-axis-caption,.step-minutes,.step-x-label,.step-y-axis,.step-chart-body p,.step-tooltip,.sample-note,.muted#who){font-size:var(--text-sm)}
.field>label,label.field{font-weight:500}.field>label{display:block;margin-bottom:6px}.field input,.field textarea,.field select{width:100%;max-width:100%}
.metric small,.badge,.tracker-marker{font-size:var(--text-sm)}.metric strong{font-size:var(--text-lg)}
.plan-open{min-height:44px}.active-plan .plan-open,.row-title,.analytics-plan-name{font-size:var(--text-lg)}.step-chart-body h3{font-size:var(--text-lg);color:var(--ink)}
.tracker-card-toggle{align-items:center;min-height:44px;gap:12px}.tracker-card-toggle>strong{font-size:var(--text-lg);font-weight:500;line-height:1.35}.document-step .tracker-card-toggle>strong{font-size:var(--text-xl)}
.tracker-card-status{font-size:var(--text-sm);font-weight:400}.tracker-card-body{padding-top:16px}.tracker-card-body[hidden]{display:none!important}
.tracker-form>strong,.tracker-meta>strong{display:block;font-size:var(--text-lg);font-weight:500;color:var(--ink);margin:16px 0 8px}.tracker-form>strong:first-child{margin-top:0}
.step-description{max-width:75ch}.step-description h5{margin:20px 0 10px}.step-description h5:first-child{margin-top:0}
.plan-source>summary,.plan-metadata>summary{cursor:pointer;min-height:44px;padding-block:10px}

.tracker-section>p[role=status]:empty{display:none}.document-plan{gap:20px}.document-plan>h3{margin:0}.document-plan>.tracker-list{display:block}.document-plan .tracker-card{padding:24px 0}.document-plan .tracker-card h3{margin:0}
.plan-prose{max-width:75ch;min-width:0;font-size:var(--text-md);line-height:1.65;overflow-wrap:anywhere}.plan-prose>h2,.plan-prose>h3,.plan-prose>h4{margin:28px 0 12px}.plan-prose>:first-child{margin-top:0}.plan-prose>p{white-space:pre-wrap;margin:12px 0}.plan-prose li{margin:6px 0}.plan-prose ul,.plan-prose ol{padding-left:1.5rem}
.plan-prose p>strong:first-child:last-child{display:block;font-size:var(--text-lg);font-weight:500;margin-top:20px}.plan-prose code{font-family:var(--font-measured);font-size:var(--text-sm);background:var(--paper-3);border-radius:4px;padding:2px 4px}.plan-prose pre{max-width:100%;overflow-x:auto;background:var(--paper-3);padding:16px;border-radius:6px}.plan-prose pre code{padding:0}.plan-prose hr{border:0;border-top:1px solid var(--line);margin:24px 0}
.plan-table-scroll{overflow-x:auto;max-width:100%;margin-block:16px}.plan-prose table{border-collapse:collapse;width:100%;font-size:var(--text-md)}.plan-prose :is(th,td){padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}.plan-prose td{overflow-wrap:normal;word-break:normal}.plan-prose th{font-size:var(--text-sm);font-weight:500;white-space:nowrap;overflow-wrap:normal}.plan-table-scroll:focus-visible{outline:3px solid var(--amber);outline-offset:2px}
.step-status-form{grid-template-columns:minmax(160px,240px) auto;align-items:end;justify-content:start;margin:0 0 24px}.step-status-form .form-error{grid-column:1/-1}.plan-source textarea{width:100%;max-width:100%;font-family:var(--font-measured);font-size:var(--text-sm);padding:12px;background:var(--paper-3);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px}
.document-plan+.plan-metadata{margin-top:24px}.plan-metadata .form{margin-top:16px}.modalbox{max-width:760px}.modalbox textarea#description{min-height:260px}
@media(max-width:600px){.step-status-form{grid-template-columns:minmax(0,1fr)}.tracker-card-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto}.tracker-card-toggle>.tracker-card-status{grid-column:1;grid-row:2}.document-plan .tracker-card{padding:20px 0}.tracker-actions button{min-height:44px}}
@media(max-width:600px){#view-detail{grid-template-columns:minmax(0,1fr)}#view-detail>.panel,#planDetail,.document-plan,.document-plan .tracker-list,.document-plan .tracker-card,.document-plan .tracker-card-body{min-width:0;max-width:100%}.plan-table-scroll{overflow:visible}.plan-prose table{table-layout:fixed}.plan-prose :is(th,td){padding:8px 4px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.plan-prose pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow-x:visible}}
@media(max-width:600px){.document-plan .tracker-collapse-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.tracker-collapse-actions>button{min-width:0;white-space:normal;overflow-wrap:anywhere}}
`;

export const UI_ANALYTICS_CSS = String.raw`
/* Hallmark · component: stage duration chart · genre: modern-minimal · theme: existing Console Paper · data: measured · v2.0.0 */
/* Critique: full stage names and exact times stay visible; one accent and a zero baseline make comparison direct. */
details.analytics-plan{padding:8px 12px}
.stage-chart-body{padding:8px 0 24px;min-width:0}.stage-chart-body h3{margin:8px 0 12px;font-size:var(--text-lg);font-weight:500}
.stage-chart-note,.stage-axis,.stage-value,.stage-axis-unit{font-size:var(--text-sm);color:var(--ink-2);font-variant-numeric:tabular-nums}
.stage-chart-note{max-width:75ch;margin:12px 0;overflow-wrap:anywhere}
.stage-rows{list-style:none;padding:0;margin:0}.stage-row,.stage-axis-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) 110px;gap:16px;align-items:center}
.stage-row{padding:16px 0;border-top:1px solid var(--line)}.stage-row:last-child{border-bottom:1px solid var(--line)}
.stage-title{min-width:0;overflow-wrap:anywhere;font-size:var(--text-sm)}.stage-value,.stage-axis-unit{text-align:right;color:var(--ink);overflow-wrap:anywhere}
.stage-bar{display:block;width:100%;height:24px;color:var(--blue)}.stage-bar rect{fill:currentColor}.stage-bar line{stroke:var(--line-strong);stroke-width:1;vector-effect:non-scaling-stroke}
.stage-axis{grid-column:2;display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.stage-axis span{min-width:0}
.analytics-plan>summary{cursor:pointer;min-height:44px;gap:16px}.analytics-plan>summary:focus-visible,.stage-chart-body button:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.analytics-plan>summary:hover .row-title{color:var(--ink-2)}.analytics-plan>summary:active{background:var(--paper-3)}
@media(max-width:600px){.stage-row,.stage-axis-row{grid-template-columns:minmax(0,1fr) 100px;gap:8px 12px}.stage-title{grid-column:1/-1}.stage-axis{grid-column:1}.stage-value,.stage-axis-unit{grid-column:2}.stage-row{padding:16px 0}.analytics-plan>summary{align-items:flex-start}}
`;

export const UI_PLAN_LISTS_CSS = String.raw`
#active{display:grid;gap:10px}
#active>.active-plan{border:1px solid var(--line);border-radius:11px;padding:14px;margin:0;color:var(--ink)}
#active>.active-plan .timer{font-size:1.7rem;letter-spacing:-.04em;margin:9px 0}
#active>.active-plan .actions{margin-top:12px}
.pager{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:12px;margin-top:16px;color:var(--muted);font-size:.85rem}
.pager-summary{min-width:0;overflow-wrap:anywhere}
.pager-controls{grid-column:2;display:flex;align-items:center;gap:9px}
.pager-page{min-width:3.5em;text-align:center;font-variant-numeric:tabular-nums}
.pager-arrow{width:44px;height:44px;display:grid;place-items:center;padding:0;border:1px solid var(--line);background:var(--paper-2);color:var(--ink)}
.pager-arrow svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.pager-arrow:hover:not(:disabled){border-color:var(--green);color:var(--green)}
.pager-arrow:disabled{opacity:.55;background:var(--paper-3);color:var(--muted);cursor:not-allowed}
@media(max-width:600px){.pager{grid-template-columns:minmax(0,1fr);gap:8px}.pager-summary{grid-row:2;text-align:center}.pager-controls{grid-column:1;grid-row:1;justify-self:center}}
`;
