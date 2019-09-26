import * as Koa from "koa";
import * as send from "koa-send";
import { AzureBlobFile } from "../lib/AzureBlobFile";
import { AzureBlobService } from "../lib/AzureBlobService";
import { User } from "../lib/User";

const cacheManager = require("cache-manager");

const ONE_HOUR = 1 * 60 * 60;
const memoryCache = cacheManager.caching({ store: "memory", max: 100, ttl: ONE_HOUR });

export class BlobsController {
  public static async index(ctx: Koa.Context) {
    const user = await User.getUser(ctx.state.user.email);
    const files: AzureBlobFile[] = [];
    if (user) {
      const accounts = user.storageAccounts.map(
        info => new AzureBlobService(info.name, info.accessKey),
      );

      const containers = (await Promise.all([
        AzureBlobService.getConfigContainers(),
        ...accounts.map(account => account.getContainers()),
      ])).reduce((flat, list) => flat.concat(list), []);

      const blobs = (await Promise.all(
        containers.map(container => BlobsController.getBlobsForContainer(container)),
      )).reduce((flat, list) => flat.concat(list), []);

      for (const blob of blobs) {
        files.push(blob);
      }
    }

    ctx.response.body = files;
  }

  public static async download(
    ctx: Koa.Context,
    account: string,
    container: string,
    filename: string,
  ) {
    try {
      const filepath = await AzureBlobFile.download(account, container, filename);
      await send(ctx, filepath);
    } catch (err) {
      ctx.throw(err);
    }
  }

  private static getBlobsForContainer(container: any) {
    const containerKey = `getBlobsForContainer-${container.account}-${container.name}`;
    return memoryCache.wrap(containerKey, () => {
      return container.getBlobs();
    });
  }
}
