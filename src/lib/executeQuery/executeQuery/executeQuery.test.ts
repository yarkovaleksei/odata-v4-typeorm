import type { Repository } from 'typeorm';

import { User } from '../../../test/entity/User.entity';
import { dataSource } from '../../../test/setup/dataSource';
import type { GetManyResponse } from '../types';
import { executeQuery } from './executeQuery';

describe('executeQuery', () => {
  const alias = 'user';
  let userRepository: Repository<User>;

  beforeEach(() => {
    userRepository = dataSource.getRepository(User);
  });

  it('вернёт все записи массивом: без $count счётчик не запрашивается', async () => {
    const users = await executeQuery(userRepository, {}, { alias });
    const allRows = await userRepository.find();

    expect(Array.isArray(users)).toBe(true);
    expect(users).toEqual(allRows);
  });

  it('вернёт { items, count } при явном $count=true', async () => {
    const users = await executeQuery(userRepository, { $count: 'true' }, { alias });
    const allRows = await userRepository.find();

    expect(users).toHaveProperty('items');
    expect(users).toHaveProperty('count');
    expect((users as GetManyResponse<User>).items).toEqual(allRows);
    expect((users as GetManyResponse<User>).count).toEqual(allRows.length);
  });

  describe('executeQuery -> $search', () => {
    it('вернёт 1 запись', async () => {
      const users = await executeQuery(userRepository, { $search: 'bob' }, { alias });
      const bobRow = await userRepository.findOne({ where: { name: 'Bob' } });

      expect(Array.isArray(users)).toBe(true);
      expect((users as User[])[0]).toEqual(bobRow);
      expect(users).toHaveLength(1);
    });

    it('вернёт 1 запись со счётчиком при $count=true', async () => {
      const users = await executeQuery(
        userRepository,
        { $search: 'bob', $count: 'true' },
        { alias }
      );
      const bobRow = await userRepository.findOne({ where: { name: 'Bob' } });

      expect((users as GetManyResponse<User>).items[0]).toEqual(bobRow);
      expect((users as GetManyResponse<User>).count).toEqual(1);
    });
  });
});
