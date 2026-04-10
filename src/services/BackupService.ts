import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export class BackupService {
    private s3Client: S3Client;

    constructor() {
        this.s3Client = new S3Client({
            region: 'auto', // R2 requires 'auto'
            endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
            },
        });
    }

    async runWeeklySnapshot(): Promise<void> {
        if (!process.env.SUPABASE_DB_URL || !process.env.R2_ACCESS_KEY_ID) {
            console.warn('[BackupService] Missing SUPABASE_DB_URL or R2 credentials. Skipping backup.');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `db-snapshot-${timestamp}.sql`;
        const filepath = path.join('/tmp', filename);

        try {
            console.log('[BackupService] Starting localized pg_dump of wait_time_history...');
            
            // Only dump the specific telemetry tables to keep it lean.
            await execAsync(
                `pg_dump "${process.env.SUPABASE_DB_URL}" -t wait_time_history -t attraction_closures -F p -f ${filepath}`
            );

            console.log('[BackupService] Compressing snapshot via gzip...');
            await execAsync(`gzip ${filepath}`);
            const gzFilepath = `${filepath}.gz`;

            const fileStream = fs.createReadStream(gzFilepath);

            console.log('[BackupService] Shipping payload to Cloudflare R2...');
            await this.s3Client.send(new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME || 'castle-backups',
                Key: `telemetry/${filename}.gz`,
                Body: fileStream as any,
                ContentType: 'application/gzip',
            }));

            console.log('[BackupService] ✅ R2 Snapshot Complete');

            // Cleanup
            if (fs.existsSync(gzFilepath)) fs.unlinkSync(gzFilepath);

        } catch (error) {
            console.error('[BackupService] ❌ Failed to execute telemetry snapshot', error);
            throw error;
        }
    }
}
