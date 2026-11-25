# Локальное обучение

## Рецепт

Из `sites/plan-time-tracker` запишите `recipe.json`, подставив ID ревизии и digest исходного экспорта. `ALL_ELIGIBLE` включает все проверенные планы.

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

При коде выхода `0` откройте `run.json`, `manifest.json`, `evaluation.json` и артефакт. Сверьте `provenance.fitRowIds` со всеми `ELIGIBLE` строками датасета. Списки должны совпасть без дублей. Сверьте пары `planId` и `sampleId` в манифесте артефакта и его `n` с числом пригодных планов. При `2` прочитайте `run.json.reason` и диагностику. При `1` прочитайте код и сообщение ошибки. Для повтора полного запуска используйте те же байты входов и каталог. При `OUTPUT_DIR_CONFLICT` сохраните прежние файлы и укажите новый `--out`.

Рецепт v4 обучает финальную модель на всех подтверждённых строках. Даты и похожесть задач не делят этот набор. После активации качество показывает сводка прогнозов, зафиксированных при первом старте. Для сравнения с ними используется время, учтённое трекером по завершённым планам.
