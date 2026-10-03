import { maintenance } from '../src/core/maintenance';
import {
  localDatabase,
  localEnvironment,
  LocalObjectStore,
  readLocalSecrets,
} from './local-runtime';
const { pg, db } = await localDatabase();
try {
  await maintenance(localEnvironment(db, new LocalObjectStore(), await readLocalSecrets()));
} finally {
  await pg.close();
}
