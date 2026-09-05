#!/usr/bin/env node
/**
 * Integration test for payment evidence upload flow
 * Tests the complete flow through actual API endpoints
 */
import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.PUBLIC_ORIGIN || "http://localhost:3000";
const testProofPath = path.join(process.cwd(), "test-proof.png");

class PaymentEvidenceIntegrationTest {
  constructor() {
    this.cookies = new Map();
    this.csrfToken = null;
  }

  async request(method, url, body = null) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url, baseUrl);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          "Content-Type": "application/json",
        },
      };

      // Add cookies
      const cookieArray = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`);
      if (cookieArray.length) {
        options.headers.cookie = cookieArray.join("; ");
      }

      // Add CSRF token
      if (this.csrfToken && ["POST", "PATCH", "DELETE"].includes(method)) {
        options.headers["x-csrf-token"] = this.csrfToken;
      }

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Store cookies
          const setCookies = res.headers["set-cookie"];
          if (setCookies) {
            setCookies.forEach((cookie) => {
              const [part] = cookie.split(";");
              const [key, value] = part.split("=");
              this.cookies.set(key, value);
            });
          }

          try {
            const parsed = data ? JSON.parse(data) : null;
            resolve({
              status: res.statusCode,
              body: parsed,
              text: data,
              headers: res.headers,
            });
          } catch {
            resolve({
              status: res.statusCode,
              body: null,
              text: data,
              headers: res.headers,
            });
          }
        });
      });

      req.on("error", reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async uploadToSignedUrl(signedUrl, fileBuffer) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(signedUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": fileBuffer.length,
        },
      };

      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });

      req.on("error", reject);
      req.write(fileBuffer);
      req.end();
    });
  }

  async run() {
    console.log("🧪 Payment Evidence Upload Integration Test\n");

    try {
      if (!fs.existsSync(testProofPath)) {
        throw new Error(`Test file not found: ${testProofPath}`);
      }
      const fileBuffer = fs.readFileSync(testProofPath);
      console.log(`✓ Test proof file ready: ${fileBuffer.length} bytes\n`);

      // Step 1: Get events
      console.log("Step 1: Fetching available events...");
      const eventsRes = await this.request("GET", "/api/v1/events");
      if (eventsRes.status !== 200 || !eventsRes.body?.data?.length) {
        throw new Error("Failed to fetch events or no events available");
      }
      const event = eventsRes.body.data[0];
      console.log(`✓ Event: ${event.title} (${event.id})`);

      // Step 2: Get event sections
      console.log("\nStep 2: Fetching event sections...");
      const eventDetailsRes = await this.request("GET", `/api/v1/events/${event.slug}`);
      const section = eventDetailsRes.body?.data?.sections?.[0];
      if (!section) throw new Error("No sections available");
      console.log(`✓ Section: ${section.name} (${section.price_minor} units)`);

      // Step 3: Register test customer
      console.log("\nStep 3: Registering test customer...");
      const timestamp = Math.random().toString(36).slice(2, 8);
      const email = `integration.${timestamp}@localhost`;
      const password = "IntegrationTest@12345";

      const registerRes = await this.request("POST", "/api/v1/auth/register", {
        email,
        password,
        fullName: "Integration Tester",
      });

      if (registerRes.status !== 201) {
        // Try with a simpler email format
        console.log(`⚠️  Registration attempt 1 failed, retrying with different email...`);
        const email2 = `int${timestamp}@local`;
        const registerRes2 = await this.request("POST", "/api/v1/auth/register", {
          email: email2,
          password,
          fullName: "Integration Tester",
        });
        if (registerRes2.status !== 201) {
          throw new Error(`Registration failed: ${registerRes2.body?.error?.message || registerRes2.status}`);
        }
        console.log(`✓ Registered: ${email2}`);
      } else {
        console.log(`✓ Registered: ${email}`);
        if (registerRes.body?.data?.csrfToken) {
          this.csrfToken = registerRes.body.data.csrfToken;
        }
      }

      // Step 4: Create order (requires login)
      console.log("\nStep 4: Creating order with manual payment...");
      const orderRes = await this.request("POST", "/api/v1/orders", {
        eventId: event.id,
        sectionId: section.id,
        quantity: 1,
        contactName: "Test Customer",
        contactEmail: email,
      });

      if (orderRes.status !== 201) {
        throw new Error(
          `Order creation failed: ${orderRes.body?.error?.message || orderRes.status}`,
        );
      }

      const orderId = orderRes.body?.data?.id;
      const paymentId = orderRes.body?.data?.payment_id;
      console.log(`✓ Order: ${orderId}`);
      console.log(`✓ Payment: ${paymentId}`);

      // Step 5: Request signed upload URL
      console.log("\nStep 5: Requesting secure upload URL...");
      const uploadUrlRes = await this.request(
        "POST",
        `/api/v1/account/payments/${paymentId}/evidence-upload`,
        {
          filename: "proof.png",
          contentType: "image/png",
          size: fileBuffer.length,
        },
      );

      if (uploadUrlRes.status !== 200) {
        throw new Error(
          `Upload URL request failed (${uploadUrlRes.status}): ${uploadUrlRes.body?.error?.message || uploadUrlRes.text}`,
        );
      }

      const signedUrl = uploadUrlRes.body?.data?.signedUrl;
      const storagePath = uploadUrlRes.body?.data?.path;

      if (!signedUrl || !storagePath) {
        throw new Error("No signed URL or storage path in response");
      }

      console.log(`✓ Got signed upload URL`);
      console.log(`  Storage path: ${storagePath}`);

      // Step 6: Upload file
      console.log("\nStep 6: Uploading file to secure storage...");
      const uploadRes = await this.uploadToSignedUrl(signedUrl, fileBuffer);

      if (uploadRes.status !== 200) {
        throw new Error(`Upload failed with status ${uploadRes.status}`);
      }

      console.log(`✓ File uploaded to storage`);

      // Step 7: Submit evidence
      console.log("\nStep 7: Submitting evidence for verification...");
      const submitRes = await this.request("POST", `/api/v1/account/payments/${paymentId}/manual-submission`, {
        evidenceStoragePath: storagePath,
        note: "Integration test proof",
      });

      if (submitRes.status !== 201) {
        throw new Error(
          `Evidence submission failed (${submitRes.status}): ${submitRes.body?.error?.message || submitRes.text}`,
        );
      }

      console.log(`✓ Evidence submitted`);
      console.log(`  Status: ${submitRes.body?.data?.status}`);

      console.log("\n✅ Integration test passed!");
      console.log("\nTest Summary:");
      console.log("✓ Event fetched");
      console.log("✓ Customer registered");
      console.log("✓ Order created");
      console.log("✓ Signed upload URL generated");
      console.log("✓ Evidence file uploaded");
      console.log("✓ Evidence recorded in database");
      console.log("\n🔒 Payment evidence flow is fully functional!");
      process.exit(0);
    } catch (error) {
      console.error(`\n❌ Test failed:`);
      console.error(`  ${error.message}`);
      process.exit(1);
    }
  }
}

const test = new PaymentEvidenceIntegrationTest();
test.run();
