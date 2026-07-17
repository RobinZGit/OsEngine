import { DatabaseSchema } from '../models/schema.model';
import { buildSchemaDiagram, extractFkLinks } from './schema-fk';

function schemaStub(): DatabaseSchema {
  return {
    schema: 'public',
    database: 'multilogictrade',
    tables: [
      {
        name: 'brokers',
        comment: 'Brokers',
        columns: [
          { name: 'id', type: 'SERIAL PRIMARY KEY', nullable: false, default: null, comment: 'PK' },
          { name: 'code', type: 'VARCHAR(50)', nullable: false, default: null, comment: null },
        ],
        indexes: [],
        constraints: [
          { name: 'brokers_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' },
        ],
      },
      {
        name: 'accounts',
        comment: 'Accounts',
        columns: [
          { name: 'id', type: 'SERIAL PRIMARY KEY', nullable: false, default: null, comment: null },
          {
            name: 'broker_id',
            type: 'INTEGER REFERENCES brokers(id) ON DELETE CASCADE',
            nullable: false,
            default: null,
            comment: 'FK → brokers',
          },
        ],
        indexes: [],
        constraints: [
          {
            name: 'accounts_broker_id_fkey',
            type: 'FOREIGN KEY',
            definition: 'FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE',
          },
        ],
      },
    ],
    routines: [],
    extensions: [],
  };
}

describe('schema-fk', () => {
  it('extractFkLinks from constraints and REFERENCES type', () => {
    const links = extractFkLinks(schemaStub());
    expect(links.length).toBe(1);
    expect(links[0]).toEqual(
      jasmine.objectContaining({
        fromTable: 'accounts',
        fromColumn: 'broker_id',
        toTable: 'brokers',
        toColumn: 'id',
      })
    );
  });

  it('buildSchemaDiagram places boxes and edges', () => {
    const layout = buildSchemaDiagram(schemaStub());
    expect(layout.boxes.length).toBe(2);
    expect(layout.edges.length).toBe(1);
    expect(layout.links.length).toBe(1);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});
