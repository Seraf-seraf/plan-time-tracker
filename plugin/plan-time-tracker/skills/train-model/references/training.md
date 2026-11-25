# Локальное обучение

## Рецепт

Для нового обучения по v4 запишите в `sites/plan-time-tracker` файл `recipe.json` с ID ревизии и digest исходного экспорта. `ALL_ELIGIBLE` включает все пригодные планы. Для точного воспроизведения используйте исходный файл рецепта.

```json
{
  "schemaVersion": 1,
  "recipeId": "atlm-teacher-hybrid-v4",
  "datasetRevisionId": "dataset-example",
  "datasetDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "selection": { "mode": "ALL_ELIGIBLE" }
}
```

```sh
node scripts/train-atlm.mjs --dataset /path/dataset.json --recipe /path/recipe.json --out /path/run
```

## Проверить результат

При коде выхода `0` откройте `run.json`, `manifest.json`, `evaluation.json` и артефакт. Для v4 сверьте `manifest.json → provenance.fitRowIds` со всеми строками `ELIGIBLE` датасета. При точном воспроизведении сверьте этот список со списком исходного запуска. Для каждого `rowId` из `provenance.fitRowIds` найдите строку датасета. В `artifact.json → manifest` ей должна соответствовать одна запись с её `planId` и `sampleId`, равным `rowId`. Проверьте отсутствие лишних записей и совпадение `artifact.n` с длиной `provenance.fitRowIds`. При `2` прочитайте `run.json.reason` и диагностику. При `1` прочитайте код и сообщение ошибки. Для повтора полного запуска используйте те же байты входов и каталог. При `OUTPUT_DIR_CONFLICT` сохраните прежние файлы и укажите новый `--out`.

Рецепт v4 обучает финальную модель на всех подтверждённых строках. Даты и похожесть задач не делят этот набор. После активации качество показывает сводка прогнозов, зафиксированных при первом старте. Для сравнения с ними используется время, учтённое трекером по завершённым планам.
