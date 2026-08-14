import { randomKey } from "@/utils/randomKey";
import { processImage } from "./processImage";
import { putFile, getPublicUrl } from "./files";
import { db } from "./db";
import {
    beginAccountDeletionUpload,
    settleAccountDeletionUpload,
} from "@/app/account/accountDeletion";

export async function uploadImage(userId: string, directory: string, prefix: string, url: string, src: Buffer) {

    // Check if image already exists
    const existing = await db.uploadedFile.findFirst({
        where: {
            accountId: userId,
            reuseKey: 'image-url:' + url
        }
    });

    if (existing && existing.thumbhash && existing.width && existing.height) {
        return {
            path: existing.path,
            thumbhash: existing.thumbhash,
            width: existing.width,
            height: existing.height
        };
    }

    // Process image
    const processed = await processImage(src);
    const key = randomKey(prefix);
    let filename = `${key}.${processed.format === 'png' ? 'png' : 'jpg'}`;
    const filePath = `public/users/${userId}/${directory}/${filename}`;

    const uploadOperation = await beginAccountDeletionUpload(userId, filePath);
    if (!uploadOperation) {
        throw new Error('Account deletion in progress');
    }
    let objectWriteCompleted = false;
    try {
        await putFile(filePath, src);
        objectWriteCompleted = true;
        await db.uploadedFile.create({
            data: {
                accountId: userId,
                path: filePath,
                reuseKey: 'image-url:' + url,
                width: processed.width,
                height: processed.height,
                thumbhash: processed.thumbhash
            }
        });
    } finally {
        if (objectWriteCompleted) {
            await settleAccountDeletionUpload(uploadOperation);
        }
    }
    return {
        path: filePath,
        thumbhash: processed.thumbhash,
        width: processed.width,
        height: processed.height
    }
}

export function resolveImageUrl(path: string) {
    return getPublicUrl(path);
}
