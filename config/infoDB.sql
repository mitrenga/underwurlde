SELECT `ndx`, `name`, `score`, `created`
FROM `rg_uw_hallOfFame`
ORDER BY `ndx` DESC
LIMIT :limit
