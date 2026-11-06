-- migrate:up
-- Keys created before the plugin default changed carry rateLimitEnabled=1 /
-- rateLimitMax=10 on the row (BUGS.md #2). Clear them so existing MCP keys work.
UPDATE "apikey" SET "rateLimitEnabled" = 0, "requestCount" = 0;

-- migrate:down
UPDATE "apikey" SET "rateLimitEnabled" = 1;
