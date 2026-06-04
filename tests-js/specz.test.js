/* Unit test for the pure VOTable parser in src/static/js/specz.js (the
 * VizieR spec-z overlay loader), reached via window.__speczTest. DOMParser is
 * provided by jsdom, so no network or Aladin is involved.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { loadScript } from "./helpers/load.js";

let S;
beforeAll(() => {
  loadScript("src/static/js/specz.js");
  S = window.__speczTest;
});

const VOTABLE = `<?xml version="1.0"?><VOTABLE><RESOURCE><TABLE>
<FIELD name="RAJ2000"/><FIELD name="DEJ2000"/><FIELD name="z"/>
<DATA><TABLEDATA>
<TR><TD>150.1</TD><TD>2.2</TD><TD>0.345</TD></TR>
<TR><TD>150.2</TD><TD>2.3</TD><TD> 1.02 </TD></TR>
</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>`;

describe("parseVOTable", () => {
  test("maps each TR to a {FIELD-name: TD-value} row", () => {
    const rows = S.parseVOTable(VOTABLE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ RAJ2000: "150.1", DEJ2000: "2.2", z: "0.345" });
  });

  test("trims whitespace from cell text (VizieR pads numeric columns)", () => {
    const rows = S.parseVOTable(VOTABLE);
    expect(rows[1].z).toBe("1.02"); // was " 1.02 "
  });

  test("a table with no rows yields an empty array", () => {
    expect(S.parseVOTable("<VOTABLE></VOTABLE>")).toEqual([]);
  });
});
