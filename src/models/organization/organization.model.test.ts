import type { default as OrganizationType, IOrganization } from '../organization.model';
import type { default as UserType, IUser } from '../user.model';
import { connectToDatabase, clearDatabase, closeDatabase } from '../../test-utils/mongo';
import type * as mongooseType from 'mongoose';
import { fetchUser, loadUser } from '../../test-utils/user';
import { loadOrganization, createOrganizationTeamUserPreset, organizationTestConfig } from '../../test-utils/organization';
import { expectedNotFoundError, getThrownError } from '../../test-utils/error';
import { loadCommonRequireMock } from '../../test-utils/requireMock';
import { ORGANIZATION_ROLES } from './organization-models-access-control';

describe('Organization Model', () => {
    let Organization: typeof OrganizationType;
    let User: typeof UserType;
    let mongoose: typeof mongooseType;
    let creatorId: mongooseType.Types.ObjectId;

    beforeAll(async () => {
        jest.resetModules();
        mongoose = require('mongoose');
        await connectToDatabase(mongoose);
        loadCommonRequireMock(jest, organizationTestConfig);
        User = loadUser();
        Organization = loadOrganization();
    });
    afterAll(() => closeDatabase(mongoose));
    beforeEach(async () => {
        await clearDatabase(mongoose);
        const user = await User.createUser({
            displayName: 'user',
            email: 'user@user.co'
        } as Partial<IUser>);
        creatorId = user._id!;
    });

    test('methods.save', async () => {
        const org = new Organization({ name: 'org', notInSchma: 'x' });
        const savedOrg = await org.save();
        expect(savedOrg).toEqual(
            expect.objectContaining({
                name: 'org',
                createdAt: expect.any(Date),
                updatedAt: expect.any(Date)
            })
        );
        expect((savedOrg as any).notInSchema).toBeUndefined();

        await expect(new Organization({ noName: 'z' }).save()).rejects.toThrow(
            'Organization validation failed: name: Path `name` is required.'
        );
    });

    test('statics.createOrganization', async () => {
        const createdOrg = await Organization.createOrganization({ name: 'org1' } as IOrganization, creatorId);

        expect(createdOrg).toEqual(
            expect.objectContaining({
                _id: expect.any(mongoose.Types.ObjectId),
                id: expect.any(String),
                name: 'org1',
                createdAt: expect.any(Date),
                updatedAt: expect.any(Date)
            })
        );
        expect(createdOrg!.accessControlList!).toHaveLength(1);
        expect(createdOrg!.accessControlList![0]!).toEqual(
            expect.objectContaining({ _id: expect.any(mongoose.Types.ObjectId), userId: creatorId, role: 'ORG_FULL_ADMIN' })
        );
        expect((createdOrg as any).notInSchema).toBeUndefined();

        expect(
            (
                await getThrownError(() => {
                    return Organization.createOrganization({ noName: 'z' } as any as IOrganization, creatorId);
                })
            ).toString()
        ).toBe('ValidationError: name: Path `name` is required.');
    });

    test('statics.updateOrganization', async () => {
        const org = await Organization.createOrganization({ name: 'org1' } as IOrganization, creatorId);
        const newId = new mongoose.Types.ObjectId();
        const validUpdate = { name: 'newOrg' };

        // organization not exists
        const organization = await Organization.updateOrganization(newId, validUpdate);
        expect(organization).toBeNull();

        const updatedOrg = (await Organization.updateOrganization(org._id!, validUpdate))!;

        expect(updatedOrg).toEqual(
            expect.objectContaining({
                id: org.id,
                name: 'newOrg',
                createdAt: org.createdAt
            })
        );
        expect(updatedOrg.updatedAt.getTime()).toBeGreaterThan(org.updatedAt.getTime());

        const updateRestrictedFields = (await Organization.updateOrganization(org._id!, {
            updatedAt: org.updatedAt,
            _id: newId,
            createdAt: new Date()
        } as unknown as Partial<Pick<IOrganization, 'name'>>))!;
        expect(updateRestrictedFields).toEqual(
            expect.objectContaining({
                id: org.id,
                name: 'newOrg',
                createdAt: org.createdAt
            })
        );
        expect(updateRestrictedFields.updatedAt.getTime()).toBeGreaterThan(updatedOrg.updatedAt.getTime());
    });

    test('statics.deleteOrganization', async () => {
        const org = await Organization.createOrganization({ name: 'org1' } as IOrganization, creatorId);
        const newId = new mongoose.Types.ObjectId();

        await Organization.deleteOrganization(newId); // delete return ok as org not exist

        await Organization.deleteOrganization(org._id!);

        const organization = await Organization.getOrganization(org._id!);
        expect(organization).toBeNull();

        await Organization.deleteOrganization(org._id!); // delete return ok as org not exist
    });

    test('statics.addUser', async () => {
        let user = await User.createUser({ displayName: 'user' } as Partial<IUser>);
        let org = await Organization.createOrganization({ name: 'org' } as IOrganization, user._id!);
        const newId = new mongoose.Types.ObjectId();

        expect(
            await getThrownError(() => {
                return Organization.addUser(newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown org id

        expect(
            await getThrownError(() => {
                return Organization.addUser(org._id!, newId!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user id

        await Organization.addUser(org._id!, user._id!);
        // organization added to user membership
        user = (await fetchUser(user._id!))!;
        expect(user.organizationMemberships).toHaveLength(1);
        const membership = user.organizationMemberships![0]!;
        expect(membership.organizationId).toStrictEqual(org._id!);
        expect(await Organization.isAuthorized(org.id!, undefined, user)).toBeTruthy();

        // organization can be found by the user
        org = (await Organization.findOrganizations(user))![0]!;
        expect(org._id!).toStrictEqual(org._id);
        // getUsers method reflect the membership
        const users = await org.getUsers();
        expect(users!).toHaveLength(1);
        expect(users![0]!._id!).toStrictEqual(user._id);

        // readding the same user works (idempotent)
        await Organization.addUser(org._id!, user._id!);
    });

    test('statics.removeUser', async () => {
        const { user, org } = await createOrganizationTeamUserPreset(User, Organization);

        const newId = new mongoose.Types.ObjectId();

        expect(
            await getThrownError(() => {
                return Organization.removeUser(newId, user._id!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown org id

        expect(
            await getThrownError(() => {
                return Organization.removeUser(org._id!, newId!);
            })
        ).toStrictEqual(expect.objectContaining(expectedNotFoundError)); // unknown user id

        await Organization.removeUser(org._id!, user._id!);
        const postRemoveUser = (await fetchUser(user._id!))!;
        expect(await Organization.isAuthorized(org.id!, undefined, postRemoveUser)).toBeFalsy();

        // organization removed from user membership
        expect(postRemoveUser.organizationMemberships).toHaveLength(0);
        // organization can't be found by the user
        expect(await Organization.findOrganizations(postRemoveUser)).toHaveLength(0);
        // getUsers method reflect the membership
        const users = await org.getUsers();
        expect(users!).toHaveLength(0);

        // removing removed user works (idempotent)
        await Organization.removeUser(org._id!, user._id!);
    });

    test('statics.getOrganization', async () => {
        // unknown org id
        const newId = new mongoose.Types.ObjectId();
        const organization = await Organization.getOrganization(newId);
        expect(organization).toBeNull();

        const { org, team } = await createOrganizationTeamUserPreset(User, Organization);
        const orgOutput = (await Organization.getOrganization(org._id!))!;

        expect(orgOutput).toStrictEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.findOrganizations', async () => {
        const { user, org, team } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.findOrganizations(user))![0]!;

        expect(Object.keys(orgOutput)).toHaveLength(7);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect(orgOutput.accessControlList![0]!).toEqual(
            expect.objectContaining({
                role: 'ORG_FULL_ADMIN',
                userId: user._id
            })
        );
        expect(orgOutput.projectGroups).toHaveLength(0);
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.objectForResponse', async () => {
        const { org, team, user: creator } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.objectForResponse(org))!;

        expect(Object.keys(orgOutput)).toHaveLength(9);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt,
                accessControlList: [
                    {
                        role: 'ORG_FULL_ADMIN',
                        userId: creator._id
                    }
                ]
            })
        );
        expect(orgOutput.projectGroups).toHaveLength(0);
        expect(orgOutput.teams).toHaveLength(1);
        expect(orgOutput.teams![0]!).toEqual(
            expect.objectContaining({
                id: team.id,
                name: team.name
            })
        );
    });

    test('statics.objectForListResponse', async () => {
        const { org } = await createOrganizationTeamUserPreset(User, Organization);

        const orgOutput = (await Organization.objectForListResponse(org))!;

        expect(Object.keys(orgOutput)).toHaveLength(5);
        expect(orgOutput).toEqual(
            expect.objectContaining({
                id: org.id,
                name: org.name,
                createdAt: org.createdAt,
                updatedAt: org.updatedAt
            })
        );
        expect((orgOutput as any).teams).toBeUndefined();
        expect((orgOutput as any).registeredThemes).toBeUndefined();
    });

    test('statics.teamForResponse', async () => {
        const { user: creator, team } = await createOrganizationTeamUserPreset(User, Organization);

        const outputTeam = await Organization.teamForResponse(team);
        expect(Object.keys(outputTeam)).toHaveLength(4);
        expect(outputTeam.id).toBeDefined();
        expect(outputTeam.name).toBeDefined();
        expect(outputTeam.logoPath).toBeDefined();
        expect(outputTeam.accessControlList).toHaveLength(1);
        expect(outputTeam.accessControlList![0]!).toEqual({
            role: 'TEAM_ADMIN',
            userId: creator._id
        });
    });

    test('statics.userForListResponse', async () => {
        const { user, org, team } = await createOrganizationTeamUserPreset(User, Organization);

        const newId = new mongoose.Types.ObjectId();
        const unknownOrgIdOutputUserResponse = (await Organization.userForListResponse(newId, user))!;
        expect(unknownOrgIdOutputUserResponse.teamIds).toHaveLength(0);

        const outputUserResponse = (await Organization.userForListResponse(org!._id!, user))!;
        expect(Object.keys(outputUserResponse)).toHaveLength(4);
        expect(outputUserResponse).toEqual(
            expect.objectContaining({
                id: user.id,
                displayName: user.displayName,
                email: user.email
            })
        );
        expect(outputUserResponse.teamIds).toHaveLength(1);
        expect(outputUserResponse.teamIds[0]).toStrictEqual(team.id);
    });

    test('statics.projectGroupForResponse', async () => {
        const createdOrganization = await Organization.createOrganization(
            {
                name: 'org'
            } as IOrganization,
            creatorId
        );
        const validProjectGroupMockData = { name: 'test project' };
        const organization = await Organization.createProjectGroup(createdOrganization._id!, validProjectGroupMockData, creatorId);
        const projectGroup = (await organization!.getProjectGroups())![0]!;

        const projectGroupJSON = (await Organization.projectGroupForResponse(projectGroup))!;
        expect(Object.keys(projectGroupJSON)).toHaveLength(3);
        expect(projectGroupJSON).toEqual(
            expect.objectContaining({
                id: projectGroup.id,
                name: projectGroup.name
            })
        );
        expect(projectGroupJSON.accessControlList![0]!).toEqual({
            role: 'PROJECT_GROUP_ADMIN',
            userId: creatorId
        });
    });

    describe('Access Control List', () => {
        let preset: Record<string, any>;
        beforeEach(async () => {
            preset = await createOrganizationTeamUserPreset(User, Organization);
        });
        test('statics.isAuthorized non organization user', async () => {
            const { org } = preset;
            const nonOrganizationUser = await User.createUser({
                displayName: 'user',
                email: 'user@user.co'
            });
            // user not in the organization should not have any access
            expect(await Organization.isAuthorized(org.id!, undefined, nonOrganizationUser)).toBeFalsy();
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], nonOrganizationUser)).toBeFalsy();
        });
        test('statics.isAuthorized organization user without role', async () => {
            const { user, org } = preset;
            // Default user in org: have org-member (undefined role list)
            expect(await Organization.isAuthorized(org.id!, undefined, user)).toBeTruthy();
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], user)).toBeFalsy();
        });
        test('statics.isAuthorized by user role', async () => {
            const { user, org } = preset;

            await Organization.setUserRole(org._id!, ORGANIZATION_ROLES.ORG_ADMIN, user._id);
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], user)).toBeTruthy();

            await Organization.removeUserRole(org._id!, user._id);
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], user)).toBeFalsy();
        });
        test('statics.isAuthorized by team role', async () => {
            const { user, org, team } = preset;

            await Organization.setTeamRole(org._id!, ORGANIZATION_ROLES.ORG_ADMIN, team._id);
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], user)).toBeTruthy();

            await Organization.removeTeamRole(org._id!, team._id);
            expect(await Organization.isAuthorized(org.id!, [ORGANIZATION_ROLES.ORG_ADMIN], user)).toBeFalsy();
        });
    });
});
