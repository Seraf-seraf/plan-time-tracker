import { UUID, appError, assertExactKeys, isPlainRecord } from '../shared/index.js';

function documentSections(text) {
  if (typeof text !== 'string' || !text.trim())
    throw appError('VALIDATION_ERROR', 'Вставьте полный текст плана.');
  const headings = [];
  let fence = null;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const value = line[0].replace(/\r?\n$/, '');
    const code = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (code) {
      if (!fence) fence = { character: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.character && code[1].length >= fence.length && !code[2].trim())
        fence = null;
      continue;
    }
    if (fence) continue;
    const heading = value.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (heading) headings.push({ level: heading[1].length, title: heading[2], offset: line.index });
  }
  const stagePattern =
    /^(?:\*\*)?(?:(?:Этап|Шаг|Stage|Step)[ \t]+([A-ZА-Я]*[0-9]+(?:[-_.][A-ZА-Я0-9]+)*|[A-ZА-Я]+-[0-9]+)|([A-ZА-Я]+[-_]?[0-9]+(?:[-_][A-ZА-Я0-9]+)*))(?=[ \t.:)—–*-]|$)/iu;
  const stages = headings.filter((h) => stagePattern.test(h.title));
  if (!stages.length)
    throw appError(
      'VALIDATION_ERROR',
      'В плане нужны заголовки этапов, например «## Этап 1. Название» или «## DATA-001. Название».',
    );
  const nextOffsets = new Map(),
    openHeadings = [];
  for (const heading of headings) {
    while (openHeadings.length && openHeadings.at(-1).level >= heading.level)
      nextOffsets.set(openHeadings.pop(), heading.offset);
    openHeadings.push(heading);
  }
  const ids = new Set();
  return stages.map((stage, index) => {
    const match = stage.title.match(stagePattern),
      id = match[1] || match[2];
    if (ids.has(id.toUpperCase()) || stage.level !== stages[0].level || stage.title.length > 200)
      throw appError(
        'VALIDATION_ERROR',
        'У этапов должны быть разные номера, один уровень заголовков и названия до 200 символов.',
      );
    ids.add(id.toUpperCase());
    return {
      key: id.toUpperCase(),
      start: stage.offset,
      end: nextOffsets.get(stage) ?? text.length,
      ordinal: index + 1,
      title: stage.title.replace(/^\*\*|\*\*$/g, ''),
      content: text.slice(stage.offset, nextOffsets.get(stage) ?? text.length),
    };
  });
}

function parsePlanDocument(text) {
  return documentSections(text).map(({ ordinal, title, content }) => ({
    stepId: crypto.randomUUID(),
    ordinal,
    title,
    content,
  }));
}

function isDocumentUpdate(payload) {
  return Object.hasOwn(payload, 'planText') || Object.hasOwn(payload, 'stepEdits');
}

function validateDocumentUpdate(payload) {
  const full = Object.hasOwn(payload, 'planText');
  const partial = Object.hasOwn(payload, 'stepEdits');
  if (full && partial)
    throw appError('VALIDATION_ERROR', 'Передайте planText или stepEdits.');
  assertExactKeys(payload, new Set(['planId', full ? 'planText' : 'stepEdits']), 'payload');
  if (full) {
    return documentSections(payload.planText);
  }
  if (!Array.isArray(payload.stepEdits) || !payload.stepEdits.length)
    throw appError('VALIDATION_ERROR', 'stepEdits должен содержать хотя бы один этап.');
  const ids = new Set();
  for (const edit of payload.stepEdits) {
    if (!isPlainRecord(edit) || typeof edit.stepId !== 'string' || !UUID.test(edit.stepId))
      throw appError('VALIDATION_ERROR', 'Для правки этапа нужен UUID stepId.');
    assertExactKeys(edit, new Set(['stepId', 'markdown']), 'Правка этапа');
    if (ids.has(edit.stepId))
      throw appError('VALIDATION_ERROR', 'Передайте каждый stepId один раз.');
    ids.add(edit.stepId);
    const sections = documentSections(edit.markdown);
    if (sections.length !== 1 || sections[0].start !== 0 || sections[0].end !== edit.markdown.length)
      throw appError('VALIDATION_ERROR', 'Передайте Markdown ровно одного этапа с заголовком.');
  }
  return null;
}

function revisePlanDocument(payload, oldMarkdown, oldSteps, fullSections) {
  const previous = oldMarkdown === null ? [] : documentSections(oldMarkdown);
  if (previous.length !== oldSteps.length || previous.some((section, i) =>
    section.ordinal !== oldSteps[i].ordinal || section.title !== oldSteps[i].title
      || section.content !== oldSteps[i].content)) {
    throw appError('INVALID_TRANSITION', 'Исходный Markdown и сохранённые этапы не совпадают.', 409);
  }
  const previousByKey = new Map(previous.map((section, i) => [section.key, oldSteps[i]]));
  let markdown = payload.planText;
  let next = fullSections;
  if (!next) {
    const edits = new Map(payload.stepEdits.map(edit => [edit.stepId, edit.markdown]));
    const blocks = previous.map((section, index) => {
      const stepId = oldSteps[index].step_id;
      if (!edits.has(stepId)) return section;
      let content = edits.get(stepId);
      edits.delete(stepId);
      if (documentSections(content)[0].key !== section.key)
        throw appError('VALIDATION_ERROR', 'Для смены идентификатора этапа используйте planText.');
      if (!content.endsWith('\n') && section.end < oldMarkdown.length)
        content += section.content.match(/(?:\r?\n)+$/)?.[0] ?? '\n';
      return { ...section, content };
    });
    if (edits.size) throw appError('STEP_NOT_FOUND', 'Этап не найден в этом плане.', 404);
    let cursor = 0;
    const parts = [];
    for (const block of blocks) {
      parts.push(oldMarkdown.slice(cursor, block.start), block.content);
      cursor = block.end;
    }
    parts.push(oldMarkdown.slice(cursor));
    markdown = parts.join('');
    next = documentSections(markdown);
    if (next.length !== blocks.length || next.some((section, i) =>
      section.key !== blocks[i].key || section.content !== blocks[i].content)) {
      throw appError('VALIDATION_ERROR', 'Правка меняет границы этапов. Используйте planText.');
    }
  }
  if (markdown === oldMarkdown)
    throw appError('VALIDATION_ERROR', 'В документе нет изменений.');

  const steps = next.map(({ key, ordinal, title, content }) => {
    const existing = previousByKey.get(key);
    previousByKey.delete(key);
    return {
      stepId: existing?.step_id ?? crypto.randomUUID(),
      ordinal, title, content,
      changed: !!existing && (existing.ordinal !== ordinal || existing.title !== title
        || existing.content !== content),
    };
  });
  return { markdown, steps, removed: [...previousByKey.values()].map(step => step.step_id) };
}

export { isDocumentUpdate, parsePlanDocument, revisePlanDocument, validateDocumentUpdate };
