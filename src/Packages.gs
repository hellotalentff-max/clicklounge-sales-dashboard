/**
 * Packages.gs
 * Configurable studio packages. Packages are disabled, never deleted, so old
 * sales keep a valid reference; each sale also stores the package name and
 * price at the time of sale.
 */

function listPackages(token, includeInactive) {
  return api_(function () {
    requireAdmin_(token);
    return rows_(SHEET.PACKAGES)
      .filter(function (p) { return includeInactive || p.Active; })
      .map(function (p) { return publicRow_(p); })
      .sort(function (a, b) { return (a.Price || 0) - (b.Price || 0) || a.PackageName.localeCompare(b.PackageName); });
  });
}

function savePackage(token, input) {
  return api_(function () {
    const admin = requireAdmin_(token);
    input = input || {};
    return withLock_(function () {
      const existing = input.PackageID ? findById_(SHEET.PACKAGES, 'PackageID', input.PackageID) : null;
      if (input.PackageID && !existing) throw appError_('Package not found.', 'NOT_FOUND');
      const name = str_(input.PackageName, 'Package name', { required: true, maxLength: 100 });
      const clash = rows_(SHEET.PACKAGES).find(function (p) {
        return p.PackageName.toLowerCase() === name.toLowerCase() && (!existing || p.PackageID !== existing.PackageID);
      });
      if (clash) throw appError_('A package named "' + name + '" already exists.');
      const record = {
        PackageName: name,
        Price: num_(input.Price, 'Package price', { min: 0 }),
        Active: input.Active === undefined ? true : toBool_(input.Active),
        Description: str_(input.Description, 'Description', { maxLength: 500 }),
        UpdatedAt: nowStr_()
      };
      let id;
      if (existing) {
        id = existing.PackageID;
        updateRow_(SHEET.PACKAGES, 'PackageID', id, record);
        auditFieldChanges_(admin, id, Object.assign({}, existing, { Active: existing.Active ? 'Active' : 'Disabled' }),
          Object.assign({}, record, { Active: record.Active ? 'Active' : 'Disabled' }),
          [['PackageName', 'package name'], ['Price', 'package price', 'money'], ['Active', 'package status'], ['Description', 'description']],
          name);
      } else {
        id = newId_('PKG');
        insertRows_(SHEET.PACKAGES, [Object.assign({ PackageID: id, CreatedAt: record.UpdatedAt }, record)]);
        logAudit_(admin, 'Added package ' + name + ' at ' + money_(record.Price), id, '', record);
      }
      return ok_({ packageId: id }, existing ? 'Package updated.' : 'Package added.');
    });
  });
}
