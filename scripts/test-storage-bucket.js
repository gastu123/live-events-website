#!/usr/bin/env node
/**
 * Simple test that the payment evidence storage bucket is working
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucketName = process.env.MANUAL_PAYMENT_EVIDENCE_BUCKET || "manual-payment-evidence";

if (!supabaseUrl || !serviceRoleKey) {
  console.error("❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function test() {
  console.log("🧪 Testing Payment Evidence Storage Bucket\n");

  try {
    // Create test data
    const testProofPath = path.join(process.cwd(), "test-proof.png");
    const userId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const filename = `test-${Date.now()}.png`;
    const storagePath = `${userId}/${paymentId}/${filename}`;

    console.log("Step 1: Checking test file...");
    if (!fs.existsSync(testProofPath)) {
      throw new Error(`Test proof file not found: ${testProofPath}`);
    }
    const fileBuffer = fs.readFileSync(testProofPath);
    console.log(`✓ Test file ready: ${fileBuffer.length} bytes`);

    // Step 2: Request signed upload URL
    console.log("\nStep 2: Getting signed upload URL...");
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .createSignedUploadUrl(storagePath);

    if (uploadError) {
      throw new Error(
        `Failed to get signed upload URL: ${uploadError.message}\n` +
        `This usually means:\n` +
        `  - The bucket "${bucketName}" doesn't exist\n` +
        `  - Supabase credentials are incorrect\n` +
        `  - Storage permissions are not configured`,
      );
    }

    const signedUrl = uploadData.signedUrl;
    console.log(`✓ Got signed upload URL`);
    console.log(`  Path: ${storagePath}`);
    console.log(`  URL: ${signedUrl.split("?")[0].slice(0, 80)}...`);

    // Step 3: Upload file
    console.log("\nStep 3: Uploading file to signed URL...");
    const uploadRes = await fetch(signedUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      const errorText = await uploadRes.text();
      throw new Error(
        `Upload failed with status ${uploadRes.status}: ${errorText}`,
      );
    }

    console.log(`✓ File uploaded successfully`);

    // Wait a moment for file to be indexed
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 4: List files to verify
    console.log("\nStep 4: Verifying file in storage...");
    const { data: files, error: listError } = await supabase.storage
      .from(bucketName)
      .list(paymentId);

    if (listError) {
      throw new Error(`Failed to list files: ${listError.message}`);
    }

    const uploadedFile = files?.find((f) => f.name === filename);
    if (!uploadedFile) {
      console.warn(
        `⚠️  File not found in listing (may be a propagation delay). Files in ${paymentId}: ${files?.map((f) => f.name).join(", ") || "none"}`,
      );
      // Try to access directly instead
      console.log("  Attempting direct file access instead...");
      const { data: fileData, error: getError } = await supabase.storage
        .from(bucketName)
        .download(storagePath);
      
      if (getError) {
        throw new Error(`File not accessible: ${getError.message}`);
      }

      console.log(`✓ File verified by direct access`);
      console.log(`  Size: ${fileData.size} bytes`);
    } else {
      console.log(`✓ File found in storage`);
      console.log(`  Filename: ${uploadedFile.name}`);
      console.log(`  Size: ${uploadedFile.metadata?.size || "unknown"} bytes`);
    }

    // Step 5: Generate signed access URL
    console.log("\nStep 5: Testing signed access URL...");
    const { data: accessData, error: accessError } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(storagePath, 60);

    if (accessError) {
      throw new Error(`Failed to generate signed access URL: ${accessError.message}`);
    }

    const accessUrl = accessData.signedUrl;
    console.log(`✓ Generated signed access URL`);
    console.log(`  Valid for: 60 seconds`);
    console.log(`  URL: ${accessUrl.split("?")[0].slice(0, 80)}...`);

    // Step 6: Verify file is NOT public
    console.log("\nStep 6: Verifying file is NOT publicly accessible...");
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucketName}/${storagePath}`;
    const publicRes = await fetch(publicUrl, { method: "HEAD" });

    if (publicRes.ok || publicRes.status === 200) {
      throw new Error("⚠️  SECURITY ISSUE: File is publicly accessible!");
    }

    console.log(`✓ File is NOT publicly accessible (${publicRes.status})`);
    console.log(`  Public URL returns: ${publicRes.status} (expected to fail)`);

    // Step 7: Clean up
    console.log("\nStep 7: Cleaning up test file...");
    const { error: deleteError } = await supabase.storage
      .from(bucketName)
      .remove([storagePath]);

    if (deleteError) {
      console.warn(`⚠️  Warning: Failed to delete test file: ${deleteError.message}`);
    } else {
      console.log(`✓ Test file cleaned up`);
    }

    console.log("\n✅ All storage tests passed!");
    console.log("\nSummary:");
    console.log("1. ✓ Bucket exists and is accessible");
    console.log("2. ✓ Signed upload URLs work");
    console.log("3. ✓ File uploads are successful");
    console.log("4. ✓ Files are stored in private bucket");
    console.log("5. ✓ Admin can generate signed access URLs");
    console.log("6. ✓ Files are NOT publicly accessible");
    console.log("\n🔒 Storage is configured correctly for secure evidence.");
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Test failed:`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

test();
