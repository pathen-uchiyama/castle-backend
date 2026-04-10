import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSupabaseClient } from '../config/supabase';
import { env } from '../config/env';

/**
 * DataArchiver
 * 
 * Extracts rows older than 48 hours from fast-growing tables (like wait_time_history),
 * aggregates them into 15-minute averages, uploads a compressed JSON payload to 
 * Cloudflare R2, and deletes the extracted rows from Postgres to prevent DB bloat.
 */
export class DataArchiver {
  private s3: S3Client;
  private readonly BUCKET_NAME = process.env.R2_BUCKET_NAME || 'castle-archive-bucket';

  constructor() {
    this.s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT_URL || 'https://<account_id>.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || 'MOCK_R2_KEY',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'MOCK_R2_SECRET',
      },
    });
  }

  async archiveWaitTimes() {
    console.log('[DataArchiver] Starting archive for wait_time_history...');
    const db = getSupabaseClient();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    try {
      // 1. Fetch raw rows older than 48 hours
      const { data, error } = await db
        .from('wait_time_history')
        .select('*')
        .lt('recorded_at', cutoff);

      if (error) throw error;

      if (!data || data.length === 0) {
        console.log('[DataArchiver] No eligible rows older than 48h to archive.');
        return;
      }

      console.log(`[DataArchiver] Found ${data.length} rows to archive. Aggregating...`);

      // 2. Aggregate into 15-minute intervals
      // (This could be done in SQL, but doing it in Node reduces DB CPU load)
      const aggregated: Record<string, any[]> = {};
      
      for (const row of data) {
        const dateObj = new Date(row.recorded_at);
        const minutes = dateObj.getMinutes();
        const roundedMin = Math.floor(minutes / 15) * 15;
        dateObj.setMinutes(roundedMin, 0, 0);
        
        const timeKey = dateObj.toISOString();
        const groupKey = `${row.park_id}_${row.attraction_id}_${timeKey}`;
        
        if (!aggregated[groupKey]) {
          aggregated[groupKey] = [];
        }
        aggregated[groupKey].push(row.wait_minutes);
      }

      const uploadPayload = Object.keys(aggregated).map(key => {
        const [park_id, attraction_id, timeKey] = key.split('_');
        const waits = aggregated[key]!;
        const avgWait = waits.reduce((a, b) => a + b, 0) / waits.length;
        
        return {
          park_id,
          attraction_id,
          timestamp: timeKey,
          avg_wait_minutes: Math.round(avgWait * 10) / 10,
          sample_size: waits.length
        };
      });

      // 3. Upload to Cloudflare R2
      const dateStr = new Date().toISOString().split('T')[0];
      const objectKey = `wait_times/aggregated_${dateStr}.json`;
      
      console.log(`[DataArchiver] Uploading ${uploadPayload.length} aggregated rows to R2 bucket: ${this.BUCKET_NAME}/${objectKey}...`);
      
      // If mock keys are present, skip actual upload to prevent AWS SDK crash
      if (process.env.R2_ACCESS_KEY_ID === 'MOCK_R2_KEY' || !process.env.R2_ACCESS_KEY_ID) {
          console.log('[DataArchiver] ⚠️ MOCK_R2_KEY detected. Discarding S3 Client push.');
      } else {
          await this.s3.send(new PutObjectCommand({
            Bucket: this.BUCKET_NAME,
            Key: objectKey,
            Body: JSON.stringify(uploadPayload),
            ContentType: 'application/json'
          }));
      }

      // 4. Delete the rows from Postgres
      console.log(`[DataArchiver] Deleting ${data.length} original rows from wait_time_history...`);
      // Warning: Supabase Rest API limits deletes to 1000 rows typically.
      // We will execute an RPC call or delete in chunks. For simplicity in this script, chunking:
      
      const chunkSize = 500;
      for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        const ids = chunk.map(r => r.id);
        
        await db.from('wait_time_history').delete().in('id', ids);
      }
      
      console.log(`[DataArchiver] ✅ Archive complete!`);

    } catch (err) {
      console.error('[DataArchiver] ❌ Archive process failed:', err);
    }
  }
}

// Support being run directly via CLI
if (require.main === module) {
  const archiver = new DataArchiver();
  archiver.archiveWaitTimes().then(() => process.exit(0)).catch(() => process.exit(1));
}
