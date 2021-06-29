# pankkilinkki

## View logs

```
cp .env.test .env
serverless logs --function linkki --stage prod --startTime 2h -t
```

# Deploy

```
serverless deploy --stage prod -f linkki
```
