const fs = require('fs');
const path = 'test/unit/app-events.test.ts';
let s = fs.readFileSync(path, 'utf8');
const tests = `
  it("describes adding an email address", () => {
    const actor = human(USER_1);
    const event = {
      id: 200,
      seq: 200,
      created_at: "2025-01-01T00:00:00Z",
      actor,
      entity_type: "user_email",
      entity_id: 1,
      action: "create",
      after: { user_id: USER_2, address: "test@example.com" },
    };
    const v = describeEvent(event, ctx);
    expect(v.noun).toContain("test@example.com");
  });

  it("describes removing an email address", () => {
    const actor = human(USER_1);
    const event = {
      id: 201,
      seq: 201,
      created_at: "2025-01-01T00:00:00Z",
      actor,
      entity_type: "user_email",
      entity_id: 1,
      action: "archive",
      before: { user_id: USER_2, address: "test@example.com" },
    };
    const v = describeEvent(event, ctx);
    expect(v.noun).toContain("test@example.com");
  });

  it("describes listing an attachment on an email", () => {
    const actor = system();
    const event = {
      id: 202,
      seq: 202,
      created_at: "2025-01-01T00:00:00Z",
      actor,
      entity_type: "attachment",
      entity_id: 1,
      action: "create",
      after: { filename: "invoice.pdf", capture_id: 10 },
    };
    const v = describeEvent(event, ctx);
    expect(v.suffix).toContain("on an email");
    expect(v.title).toContain("invoice.pdf");
  });
`;
s = s.replace(/\n\}\);\n$/, tests + "\n});\n");
fs.writeFileSync(path, s);
console.log('done');
