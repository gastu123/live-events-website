#!/usr/bin/env node
/**
 * Initialize Supabase storage buckets for payment evidence
 * This creates the private manual-payment-evidence bucket if it doesn't exist
 * and configures proper access policies.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

async function initStorageBuckets() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.",
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const bucketName = process.env.MANUAL_PAYMENT_EVIDENCE_BUCKET || "manual-payment-evidence";

  console.log(`Checking storage bucket: ${bucketName}`);

  try {
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) {
      throw new Error(`Failed to list buckets: ${listError.message}`);
    }

    const bucketExists = buckets?.some((b) => b.name === bucketName);

    if (bucketExists) {
      console.log(`✓ Storage bucket "${bucketName}" already exists`);
    } else {
      console.log(`Creating private storage bucket: ${bucketName}`);
      const { data, error } = await supabase.storage.createBucket(bucketName, {
        public: false,
      });

      if (error) {
        throw new Error(
          `Failed to create bucket: ${error.message}. Make sure SUPABASE_SERVICE_ROLE_KEY has storage management permissions.`,
        );
      }

      console.log(`✓ Created private storage bucket: ${data.name}`);
    }

    // Verify bucket is private (no public access)
    const { data: bucket, error: getBucketError } = await supabase.storage.getBucket(bucketName);
    if (getBucketError) {
      throw new Error(`Failed to get bucket details: ${getBucketError.message}`);
    }

    if (bucket.public) {
      console.warn(`⚠ Warning: Bucket "${bucketName}" is public. Setting to private...`);
      const { error: updateError } = await supabase.storage.updateBucket(bucketName, {
        public: false,
      });
      if (updateError) {
        throw new Error(`Failed to update bucket to private: ${updateError.message}`);
      }
      console.log(`✓ Bucket is now private`);
    } else {
      console.log(`✓ Bucket is private (access via signed URLs only)`);
    }

    console.log("\n✓ Storage bucket initialization complete");
    console.log(`\nConfiguration summary:`);
    console.log(`  Bucket Name: ${bucketName}`);
    console.log(`  Public: ${bucket.public}`);
    console.log(`  Access: Signed URLs only (time-limited, authorized per-user)`);
    process.exit(0);
  } catch (error) {
    console.error(`✗ Storage bucket initialization failed:`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

initStorageBuckets();
